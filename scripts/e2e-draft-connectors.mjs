import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const runtimeDir = path.join(root, ".runtime");
let apiBaseUrl = process.env.E2E_API_BASE_URL ?? "";

fs.mkdirSync(runtimeDir, { recursive: true });

function tail(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const content = fs.readFileSync(filePath, "utf8");
  return content.slice(Math.max(0, content.length - 5000));
}

function startService(name, args, extraEnv = {}) {
  const stdoutPath = path.join(runtimeDir, `${name}-draft-e2e.out.log`);
  const stderrPath = path.join(runtimeDir, `${name}-draft-e2e.err.log`);
  const stdout = fs.openSync(stdoutPath, "w");
  const stderr = fs.openSync(stderrPath, "w");
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6380",
      ...extraEnv,
    },
    stdio: ["ignore", stdout, stderr],
  });

  fs.closeSync(stdout);
  fs.closeSync(stderr);
  return { name, child, stdoutPath, stderrPath };
}

async function stopService(service) {
  if (!service || service.child.exitCode !== null) {
    return;
  }

  service.child.kill("SIGTERM");
  const timeout = delay(3000).then(() => {
    if (service.child.exitCode === null) {
      service.child.kill("SIGKILL");
    }
  });

  await Promise.race([once(service.child, "exit"), timeout]);
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function requestAbsoluteJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${url} failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function waitForApi(api) {
  for (let i = 0; i < 40; i += 1) {
    if (api.child.exitCode !== null) {
      throw new Error(`API exited early.\n${tail(api.stderrPath)}`);
    }

    try {
      return await requestJson("/health");
    } catch {
      await delay(500);
    }
  }

  throw new Error(`API health check did not become ready.\n${tail(api.stderrPath)}`);
}

function ensureBuildOutput() {
  for (const filePath of ["apps/api/dist/main.js", "apps/worker/dist/main.js", "apps/draft-connector/dist/main.js"]) {
    if (!fs.existsSync(path.join(root, filePath))) {
      throw new Error(`Missing ${filePath}. Run pnpm build before pnpm test:draft-connectors.`);
    }
  }
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Free port probe did not expose a TCP address.");
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForHealth(service, url, label) {
  for (let i = 0; i < 40; i += 1) {
    if (service.child.exitCode !== null) {
      throw new Error(`${label} exited early.\n${tail(service.stderrPath)}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {
      await delay(500);
    }
  }

  throw new Error(`${label} health check did not become ready.\n${tail(service.stderrPath)}`);
}

function readDraftOutbox(outboxDir, platforms) {
  return platforms.flatMap((platform) => {
    const platformDir = path.join(outboxDir, platform);
    if (!fs.existsSync(platformDir)) {
      return [];
    }

    return fs.readdirSync(platformDir)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => {
        const content = fs.readFileSync(path.join(platformDir, fileName), "utf8");
        return JSON.parse(content);
      });
  });
}

ensureBuildOutput();

const connectorPort = await getFreePort();
const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
const queueName = `mp-publishing-draft-e2e-${Date.now()}`;
const apiPort = process.env.E2E_API_BASE_URL ? undefined : await getFreePort();
apiBaseUrl = apiBaseUrl || `http://127.0.0.1:${apiPort}`;
const outboxDir = path.join(runtimeDir, `draft-connector-e2e-${Date.now()}`);
fs.rmSync(outboxDir, { recursive: true, force: true });
const connectorEnv = {
  ...(apiPort ? { PORT: String(apiPort) } : {}),
  PUBLISH_QUEUE_NAME: queueName,
  DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
  DRAFT_CONNECTOR_API_KEY: "draft-secret",
  ZHIHU_REAL_PUBLISH_ENABLED: "true",
  BILIBILI_REAL_PUBLISH_ENABLED: "true",
  XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
};
const draftConnectorEnv = {
  PORT: String(connectorPort),
  DRAFT_CONNECTOR_API_KEY: "draft-secret",
  DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
  DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
};

const api = startService("api", ["apps/api/dist/main.js"], connectorEnv);
const worker = startService("worker", ["apps/worker/dist/main.js"], connectorEnv);
const draftConnector = startService("draft-connector", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

try {
  await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector");
  await waitForApi(api);
  await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

  const accountsResponse = await requestJson("/accounts");
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));

  if (accounts.length !== platforms.length) {
    throw new Error(`Missing demo accounts for draft connector platforms: ${JSON.stringify(accounts)}`);
  }

  const created = await requestJson("/publish/real", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document: {
        title: "非公众号平台真实草稿联调验证",
        summary: "验证知乎、B站、小红书可以通过 draft connector 进入真实草稿创建链路。",
        body: "这是一条自动化验证内容，用来确认非公众号平台的真实草稿连接器能被 BullMQ worker 调用。",
        tags: ["draft", "connector", "e2e"],
      },
      platforms,
      accountIds: accounts.map((account) => account.id),
      toneMode: "keep",
      preserveOriginal: true,
    }),
  });

  let task = created;
  for (let i = 0; i < 50; i += 1) {
    await delay(600);
    task = await requestJson(`/publish/tasks/${created.id}`);
    if (!["running", "queued"].includes(task.status)) {
      break;
    }
  }

  let runtime = await requestJson("/runtime/status");
  for (let i = 0; i < 20; i += 1) {
    if (runtime.queue.waiting === 0 && runtime.queue.active === 0 && runtime.queue.delayed === 0) {
      break;
    }

    await delay(300);
    runtime = await requestJson("/runtime/status");
  }

  const storedDrafts = readDraftOutbox(outboxDir, platforms);
  if (task.status !== "succeeded") {
    throw new Error(`Draft connector task did not succeed: ${task.status}`);
  }

  const draftDetails = [];
  for (const platform of platforms) {
    const target = task.results.find((item) => item.platform === platform);
    const expectedUrlPrefix = `${connectorBaseUrl}/${platform}/drafts/`;
    if (!target || target.status !== "succeeded" || !target.remoteId || !target.url?.startsWith(expectedUrlPrefix)) {
      throw new Error(`Draft connector target did not produce an HTTP draft URL for ${platform}: ${JSON.stringify(target)}`);
    }

    const detail = await requestAbsoluteJson(target.url);
    if (detail.draftId !== target.remoteId || detail.platform !== platform || detail.url !== target.url) {
      throw new Error(`Draft connector detail URL returned an unexpected payload for ${platform}: ${JSON.stringify(detail)}`);
    }

    draftDetails.push({
      platform: detail.platform,
      draftId: detail.draftId,
      title: detail.payload?.draft?.title,
      accountId: detail.accountId,
      url: detail.url,
    });
  }

  const syncedTask = await requestJson(`/publish/tasks/${created.id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const syncedTargets = [];
  if (syncedTask.status !== "succeeded") {
    throw new Error(`Draft connector sync changed task status unexpectedly: ${syncedTask.status}`);
  }

  for (const platform of platforms) {
    const beforeSync = task.results.find((item) => item.platform === platform);
    const afterSync = syncedTask.results.find((item) => item.platform === platform);
    const expectedUrlPrefix = `${connectorBaseUrl}/${platform}/drafts/`;
    if (
      !afterSync ||
      afterSync.status !== "succeeded" ||
      afterSync.remoteId !== beforeSync?.remoteId ||
      !afterSync.url?.startsWith(expectedUrlPrefix)
    ) {
      throw new Error(`Draft connector sync did not preserve a draft status for ${platform}: ${JSON.stringify(afterSync)}`);
    }

    syncedTargets.push({
      platform: afterSync.platform,
      status: afterSync.status,
      remoteId: afterSync.remoteId,
      url: afterSync.url,
    });
  }

  task = syncedTask;

  const result = {
    taskId: created.id,
    finalStatus: task.status,
    targets: task.results.map((target) => ({
      platform: target.platform,
      status: target.status,
      ok: target.ok,
      remoteId: target.remoteId,
      url: target.url,
    })),
    storedDrafts: storedDrafts.map((draft) => ({
      platform: draft.platform,
      draftId: draft.draftId,
      title: draft.payload.draft?.title,
      accountId: draft.accountId,
    })),
    draftDetails,
    syncedTargets,
    queue: runtime.queue,
  };

  console.log(JSON.stringify(result, null, 2));

  if (storedDrafts.length !== platforms.length) {
    throw new Error(`Expected ${platforms.length} stored drafts, received ${storedDrafts.length}.`);
  }

  if (runtime.queue.failed > 0 || runtime.queue.waiting > 0 || runtime.queue.active > 0) {
    throw new Error(`Publish queue is not drained: ${JSON.stringify(runtime.queue)}`);
  }
} catch (error) {
  console.error(error);
  console.error("API stderr tail:\n", tail(api.stderrPath));
  console.error("Worker stderr tail:\n", tail(worker.stderrPath));
  console.error("Draft connector stderr tail:\n", tail(draftConnector.stderrPath));
  process.exitCode = 1;
} finally {
  await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
}
