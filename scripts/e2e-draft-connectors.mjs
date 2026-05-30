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
  for (const filePath of ["apps/api/dist/main.js", "apps/worker/dist/main.js"]) {
    if (!fs.existsSync(path.join(root, filePath))) {
      throw new Error(`Missing ${filePath}. Run pnpm build before pnpm test:draft-connectors.`);
    }
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function startDraftConnectorServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const [, platform, operation] = request.url?.split("/") ?? [];
      const requestRecord = {
        authorization: request.headers.authorization,
        platform,
        operation,
        body,
      };
      requests.push(requestRecord);

      response.setHeader("content-type", "application/json");

      if (operation === "status") {
        response.end(
          JSON.stringify({
            state: "draft",
            detail: `${platform} draft connector still reports draft state.`,
            remoteId: body.remoteId,
          }),
        );
        return;
      }

      const draftId = `${platform}-draft-${requests.filter((item) => item.operation === "drafts").length}`;
      response.end(
        JSON.stringify({
          ok: true,
          draftId,
          url: `${platform}://draft/${draftId}`,
          message: `${platform} connector accepted the draft.`,
        }),
      );
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "unknown error" }));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Draft connector server did not expose a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
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

ensureBuildOutput();

const connector = await startDraftConnectorServer();
const queueName = `mp-publishing-draft-e2e-${Date.now()}`;
const apiPort = process.env.E2E_API_BASE_URL ? undefined : await getFreePort();
apiBaseUrl = apiBaseUrl || `http://127.0.0.1:${apiPort}`;
const connectorEnv = {
  ...(apiPort ? { PORT: String(apiPort) } : {}),
  PUBLISH_QUEUE_NAME: queueName,
  ZHIHU_REAL_PUBLISH_ENABLED: "true",
  ZHIHU_DRAFT_ENDPOINT: `${connector.baseUrl}/zhihu/drafts`,
  ZHIHU_DRAFT_API_KEY: "draft-secret",
  ZHIHU_STATUS_ENDPOINT: `${connector.baseUrl}/zhihu/status`,
  BILIBILI_REAL_PUBLISH_ENABLED: "true",
  BILIBILI_DRAFT_ENDPOINT: `${connector.baseUrl}/bilibili/drafts`,
  BILIBILI_DRAFT_API_KEY: "draft-secret",
  BILIBILI_STATUS_ENDPOINT: `${connector.baseUrl}/bilibili/status`,
  XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
  XIAOHONGSHU_DRAFT_ENDPOINT: `${connector.baseUrl}/xiaohongshu/drafts`,
  XIAOHONGSHU_DRAFT_API_KEY: "draft-secret",
  XIAOHONGSHU_STATUS_ENDPOINT: `${connector.baseUrl}/xiaohongshu/status`,
};

const api = startService("api", ["apps/api/dist/main.js"], connectorEnv);
const worker = startService("worker", ["apps/worker/dist/main.js"], connectorEnv);

try {
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

  const draftRequests = connector.requests.filter((request) => request.operation === "drafts");
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
    connectorRequests: draftRequests.map((request) => ({
      platform: request.platform,
      title: request.body.draft?.title,
      hasCredential: Boolean(request.body.credential),
      authorized: request.authorization === "Bearer draft-secret",
    })),
    queue: runtime.queue,
  };

  console.log(JSON.stringify(result, null, 2));

  if (task.status !== "succeeded") {
    throw new Error(`Draft connector task did not succeed: ${task.status}`);
  }

  for (const platform of platforms) {
    const target = task.results.find((item) => item.platform === platform);
    if (!target || target.status !== "succeeded" || !target.remoteId || !target.url?.includes("://draft/")) {
      throw new Error(`Draft connector target did not produce a draft reference for ${platform}: ${JSON.stringify(target)}`);
    }
  }

  if (draftRequests.length !== platforms.length) {
    throw new Error(`Expected ${platforms.length} draft connector calls, received ${draftRequests.length}.`);
  }

  if (runtime.queue.failed > 0 || runtime.queue.waiting > 0 || runtime.queue.active > 0) {
    throw new Error(`Publish queue is not drained: ${JSON.stringify(runtime.queue)}`);
  }
} catch (error) {
  console.error(error);
  console.error("API stderr tail:\n", tail(api.stderrPath));
  console.error("Worker stderr tail:\n", tail(worker.stderrPath));
  process.exitCode = 1;
} finally {
  await Promise.all([stopService(api), stopService(worker), connector.close()]);
}
