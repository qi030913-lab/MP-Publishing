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

async function requestAbsoluteJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? "GET"} ${url} failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function requestAbsoluteText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${url} failed: ${response.status} ${body}`);
  }

  return response.text();
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
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

async function startFakeUpstreamDraftService(port, expectedApiKey) {
  const requests = [];
  const statusRequests = [];
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", baseUrl).pathname;
      const [platform, operation] = pathname.split("/").filter(Boolean);

      if (request.method === "GET" && pathname === "/health") {
        if (request.headers.authorization !== `Bearer ${expectedApiKey}`) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, message: "upstream api key is invalid" }));
          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, status: "ok" }));
        return;
      }

      if (request.method !== "POST" || !["drafts", "status"].includes(operation)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "upstream route not found" }));
        return;
      }

      if (request.headers.authorization !== `Bearer ${expectedApiKey}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "upstream api key is invalid" }));
        return;
      }

      const payload = await readRequestJson(request);
      if (operation === "status") {
        const connectorDraftId = payload.connector?.draftId;
        const remoteId = payload.remoteId;
        if (!connectorDraftId || !remoteId || !payload.connector?.draftUrl) {
          response.writeHead(422, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, message: "upstream status payload is missing connector metadata" }));
          return;
        }

        statusRequests.push({
          platform,
          connectorDraftId,
          connectorDraftUrl: payload.connector.draftUrl,
          remoteId,
          accountId: payload.accountId,
          hasCredential: Boolean(payload.credential),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            state: "succeeded",
            remoteId,
            url: `https://upstream.example.test/${platform}/${remoteId}`,
            detail: `${platform} upstream draft published.`,
          }),
        );
        return;
      }

      const connectorDraftId = payload.connector?.draftId;
      if (!connectorDraftId || !payload.connector?.statusCallbackUrl || !payload.draft?.title) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "upstream payload is missing connector metadata" }));
        return;
      }

      const remoteId = `${platform}-upstream-${connectorDraftId}`;
      const url = `https://upstream.example.test/${platform}/${remoteId}`;
      requests.push({
        platform,
        connectorDraftId,
        connectorDraftUrl: payload.connector.draftUrl,
        statusCallbackUrl: payload.connector.statusCallbackUrl,
        title: payload.draft.title,
        hasCredential: Boolean(payload.credential),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          remoteId,
          url,
          state: "ready",
          detail: `${platform} upstream draft accepted.`,
        }),
      );
    })();
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  return {
    baseUrl,
    requests,
    statusRequests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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

async function runDisabledDraftPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const preflightApiPort = await getFreePort();
  const preflightQueueName = `mp-publishing-draft-preflight-e2e-${Date.now()}`;
  apiBaseUrl = `http://127.0.0.1:${preflightApiPort}`;
  const api = startService("api-draft-preflight", ["apps/api/dist/main.js"], {
    PORT: String(preflightApiPort),
    PUBLISH_QUEUE_NAME: preflightQueueName,
    DRAFT_CONNECTOR_BASE_URL: "",
    ZHIHU_REAL_PUBLISH_ENABLED: "false",
    ZHIHU_DRAFT_ENDPOINT: "",
  });

  try {
    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const zhihuAccount = accountsResponse.items.find((account) => account.platform === "zhihu");
    if (!zhihuAccount) {
      throw new Error(`Missing zhihu account for preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台真实草稿预检验证",
          summary: "验证未启用连接器时不会把真实草稿任务排入 worker。",
          body: "这条内容用于确认 API 会在创建真实草稿任务时做连接器预检。",
          tags: ["draft", "preflight", "e2e"],
        },
        platforms: ["zhihu"],
        accountIds: [zhihuAccount.id],
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    const target = created.results.find((item) => item.platform === "zhihu");
    const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];

    if (
      created.status !== "needs_manual_action" ||
      target?.status !== "needs_manual_action" ||
      !issueCodes.includes("ZHIHU_REAL_PUBLISH_DISABLED") ||
      !issueCodes.includes("ZHIHU_DRAFT_ENDPOINT_MISSING")
    ) {
      throw new Error(`Draft preflight did not mark disabled connector target correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "zhihu" }),
    });
    const retryTarget = retried.results.find((item) => item.platform === "zhihu");
    const retryIssueCodes = retryTarget?.issues?.map((issue) => issue.code) ?? [];
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      retryTarget?.status !== "needs_manual_action" ||
      !retryIssueCodes.includes("ZHIHU_REAL_PUBLISH_DISABLED") ||
      !retryIssueCodes.includes("ZHIHU_DRAFT_ENDPOINT_MISSING")
    ) {
      throw new Error(`Draft preflight retry did not keep disabled connector target on manual action: ${JSON.stringify(retried)}`);
    }

    if (
      runtimeAfterRetry.queue.waiting > 0 ||
      runtimeAfterRetry.queue.active > 0 ||
      runtimeAfterRetry.queue.delayed > 0 ||
      runtimeAfterRetry.queue.failed > 0
    ) {
      throw new Error(`Draft preflight retry should not enqueue work while connector is disabled: ${JSON.stringify(runtimeAfterRetry.queue)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targetStatus: retryTarget.status,
      attemptCount: retryTarget.attemptCount,
      issueCodes: retryIssueCodes,
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await stopService(api);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runOfflineDraftConnectorPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const preflightApiPort = await getFreePort();
  const offlineConnectorPort = await getFreePort();
  const preflightQueueName = `mp-publishing-draft-offline-e2e-${Date.now()}`;
  apiBaseUrl = `http://127.0.0.1:${preflightApiPort}`;
  const api = startService("api-draft-offline", ["apps/api/dist/main.js"], {
    PORT: String(preflightApiPort),
    PUBLISH_QUEUE_NAME: preflightQueueName,
    DRAFT_CONNECTOR_BASE_URL: `http://127.0.0.1:${offlineConnectorPort}`,
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_ENDPOINT: "",
  });

  try {
    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const zhihuAccount = accountsResponse.items.find((account) => account.platform === "zhihu");
    if (!zhihuAccount) {
      throw new Error(`Missing zhihu account for offline connector preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台真实草稿离线连接器预检验证",
          summary: "验证本地连接器离线时不会把真实草稿任务排入 worker。",
          body: "这条内容用于确认 API 会在创建真实草稿任务时探测本地 draft connector health。",
          tags: ["draft", "offline", "e2e"],
        },
        platforms: ["zhihu"],
        accountIds: [zhihuAccount.id],
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    const target = created.results.find((item) => item.platform === "zhihu");
    const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];

    if (
      created.status !== "needs_manual_action" ||
      target?.status !== "needs_manual_action" ||
      !issueCodes.includes("ZHIHU_DRAFT_CONNECTOR_OFFLINE")
    ) {
      throw new Error(`Draft preflight did not hold an offline connector target correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "zhihu" }),
    });
    const retryTarget = retried.results.find((item) => item.platform === "zhihu");
    const retryIssueCodes = retryTarget?.issues?.map((issue) => issue.code) ?? [];
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      retryTarget?.status !== "needs_manual_action" ||
      !retryIssueCodes.includes("ZHIHU_DRAFT_CONNECTOR_OFFLINE")
    ) {
      throw new Error(`Draft preflight retry did not keep offline connector target on manual action: ${JSON.stringify(retried)}`);
    }

    if (
      runtimeAfterRetry.queue.waiting > 0 ||
      runtimeAfterRetry.queue.active > 0 ||
      runtimeAfterRetry.queue.delayed > 0 ||
      runtimeAfterRetry.queue.failed > 0
    ) {
      throw new Error(`Offline connector retry should not enqueue work: ${JSON.stringify(runtimeAfterRetry.queue)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targetStatus: retryTarget.status,
      attemptCount: retryTarget.attemptCount,
      issueCodes: retryIssueCodes,
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await stopService(api);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runOfflineUpstreamDraftPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const offlineUpstreamPort = await getFreePort();
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const upstreamBaseUrl = `http://127.0.0.1:${offlineUpstreamPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-offline-upstream-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-offline-upstream-e2e-${Date.now()}`;
  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const api = startService("api-draft-offline-upstream", ["apps/api/dist/main.js"], {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
  });
  const draftConnector = startService("draft-connector-offline-upstream", ["apps/draft-connector/dist/main.js"], {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
  });

  try {
    const connectorHealth = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector offline upstream");
    const upstreamStatus = connectorHealth.upstreamDrafts?.find((item) => item.platform === "zhihu");
    if (!upstreamStatus?.draftEndpointConfigured || upstreamStatus.status !== "offline") {
      throw new Error(`Draft connector health did not expose offline upstream status: ${JSON.stringify(connectorHealth)}`);
    }

    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const zhihuAccount = accountsResponse.items.find((account) => account.platform === "zhihu");
    if (!zhihuAccount) {
      throw new Error(`Missing zhihu account for offline upstream preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台真实草稿上游离线预检验证",
          summary: "验证上游草稿服务离线时不会把真实草稿任务排入 worker。",
          body: "这条内容用于确认本地 draft connector 在线但 upstream health 失败时，API 会在入队前要求人工处理。",
          tags: ["draft", "upstream", "offline", "e2e"],
        },
        platforms: ["zhihu"],
        accountIds: [zhihuAccount.id],
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    const target = created.results.find((item) => item.platform === "zhihu");
    const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];

    if (
      created.status !== "needs_manual_action" ||
      target?.status !== "needs_manual_action" ||
      !issueCodes.includes("ZHIHU_UPSTREAM_DRAFT_CONNECTOR_OFFLINE")
    ) {
      throw new Error(`Draft preflight did not hold an offline upstream target correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "zhihu" }),
    });
    const retryTarget = retried.results.find((item) => item.platform === "zhihu");
    const retryIssueCodes = retryTarget?.issues?.map((issue) => issue.code) ?? [];
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      retryTarget?.status !== "needs_manual_action" ||
      !retryIssueCodes.includes("ZHIHU_UPSTREAM_DRAFT_CONNECTOR_OFFLINE")
    ) {
      throw new Error(`Draft preflight retry did not keep offline upstream target on manual action: ${JSON.stringify(retried)}`);
    }

    if (
      runtimeAfterRetry.queue.waiting > 0 ||
      runtimeAfterRetry.queue.active > 0 ||
      runtimeAfterRetry.queue.delayed > 0 ||
      runtimeAfterRetry.queue.failed > 0
    ) {
      throw new Error(`Offline upstream retry should not enqueue work: ${JSON.stringify(runtimeAfterRetry.queue)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targetStatus: retryTarget.status,
      attemptCount: retryTarget.attemptCount,
      issueCodes: retryIssueCodes,
      upstreamStatus: upstreamStatus.status,
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await Promise.all([stopService(api), stopService(draftConnector)]);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runOfflineUpstreamDraftRecoveryCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const upstreamPort = await getFreePort();
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-upstream-recovery-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-upstream-recovery-e2e-${Date.now()}`;
  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const serviceEnv = {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
  };
  const draftConnectorEnv = {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
  };

  const api = startService("api-draft-upstream-recovery", ["apps/api/dist/main.js"], serviceEnv);
  const worker = startService("worker-draft-upstream-recovery", ["apps/worker/dist/main.js"], serviceEnv);
  const draftConnector = startService(
    "draft-connector-upstream-recovery",
    ["apps/draft-connector/dist/main.js"],
    draftConnectorEnv,
  );
  let upstream;

  try {
    const offlineHealth = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector upstream recovery");
    const offlineStatus = offlineHealth.upstreamDrafts?.find((item) => item.platform === "zhihu");
    if (!offlineStatus?.draftEndpointConfigured || offlineStatus.status !== "offline") {
      throw new Error(`Draft connector health did not start with offline upstream status: ${JSON.stringify(offlineHealth)}`);
    }

    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const zhihuAccount = accountsResponse.items.find((account) => account.platform === "zhihu");
    if (!zhihuAccount) {
      throw new Error(`Missing zhihu account for upstream recovery verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台 upstream 恢复后重试草稿验证",
          summary: "验证上游草稿服务恢复后，原先被预检拦住的目标可以通过重试进入草稿发布。",
          body: "这条内容用于确认 needs_manual_action 不是死路，修好 upstream 后可以重试并创建真实草稿。",
          tags: ["draft", "upstream", "retry", "e2e"],
        },
        platforms: ["zhihu"],
        accountIds: [zhihuAccount.id],
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    const createdTarget = created.results.find((item) => item.platform === "zhihu");
    const issueCodes = createdTarget?.issues?.map((issue) => issue.code) ?? [];
    if (
      created.status !== "needs_manual_action" ||
      createdTarget?.status !== "needs_manual_action" ||
      !issueCodes.includes("ZHIHU_UPSTREAM_DRAFT_CONNECTOR_OFFLINE")
    ) {
      throw new Error(`Upstream recovery precondition did not hold the target: ${JSON.stringify(created)}`);
    }

    upstream = await startFakeUpstreamDraftService(upstreamPort, "upstream-secret");
    for (let i = 0; i < 20; i += 1) {
      await delay(300);
      const onlineHealth = await requestAbsoluteJson(`${connectorBaseUrl}/health`);
      const onlineStatus = onlineHealth.upstreamDrafts?.find((item) => item.platform === "zhihu");
      if (onlineStatus?.status === "online") {
        break;
      }

      if (i === 19) {
        throw new Error(`Draft connector health did not recover after upstream started: ${JSON.stringify(onlineHealth)}`);
      }
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "zhihu" }),
    });
    const retryTarget = retried.results.find((item) => item.platform === "zhihu");
    if (retryTarget?.status !== "queued") {
      throw new Error(`Upstream recovery retry should enqueue the target: ${JSON.stringify(retried)}`);
    }

    let task = retried;
    for (let i = 0; i < 50; i += 1) {
      await delay(600);
      task = await requestJson(`/publish/tasks/${created.id}`);
      if (!["running", "queued"].includes(task.status)) {
        break;
      }
    }

    const finalTarget = task.results.find((item) => item.platform === "zhihu");
    if (
      task.status !== "succeeded" ||
      finalTarget?.status !== "succeeded" ||
      !finalTarget.remoteId?.startsWith("zhihu-upstream-zhihu-draft-") ||
      !finalTarget.url?.startsWith("https://upstream.example.test/zhihu/")
    ) {
      throw new Error(`Recovered upstream draft target did not succeed: ${JSON.stringify(task)}`);
    }

    const runtimeAfterRecovery = await requestJson("/runtime/status");
    if (
      runtimeAfterRecovery.queue.waiting > 0 ||
      runtimeAfterRecovery.queue.active > 0 ||
      runtimeAfterRecovery.queue.delayed > 0 ||
      runtimeAfterRecovery.queue.failed > 0
    ) {
      throw new Error(`Recovered upstream retry left unexpected queue work: ${JSON.stringify(runtimeAfterRecovery.queue)}`);
    }

    return {
      taskId: created.id,
      initialStatus: created.status,
      retryStatus: retried.status,
      finalStatus: task.status,
      target: {
        platform: finalTarget.platform,
        status: finalTarget.status,
        remoteId: finalTarget.remoteId,
        url: finalTarget.url,
      },
      upstreamRequests: upstream.requests.map((request) => ({
        platform: request.platform,
        connectorDraftId: request.connectorDraftId,
      })),
      queue: runtimeAfterRecovery.queue,
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    if (upstream) {
      await upstream.close();
    }
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runUpstreamDraftForwardingCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const upstreamPort = await getFreePort();
  const connectorPort = await getFreePort();
  const apiPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "upstream-secret");
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const upstreamOutboxDir = path.join(runtimeDir, `draft-connector-upstream-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-upstream-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(upstreamOutboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const connectorEnv = {
    PORT: String(apiPort),
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
    DRAFT_CONNECTOR_OUTBOX_DIR: upstreamOutboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/zhihu/status`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/bilibili/status`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/status`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
  };

  const api = startService("api-draft-upstream", ["apps/api/dist/main.js"], connectorEnv);
  const worker = startService("worker-draft-upstream", ["apps/worker/dist/main.js"], connectorEnv);
  const draftConnector = startService("draft-connector-upstream", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

  try {
    const upstreamHealth = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector upstream");
    if (
      platforms.some(
        (platform) =>
          !upstreamHealth.upstreamDrafts?.some(
            (item) =>
              item.platform === platform &&
              item.draftEndpointConfigured &&
              item.statusEndpointConfigured &&
              item.status === "online",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not report every upstream endpoint: ${JSON.stringify(upstreamHealth)}`);
    }
    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for upstream draft verification: ${JSON.stringify(accounts)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台 upstream 草稿联调验证",
          summary: "验证本地 draft connector 可以把草稿同步转发给上游平台代理。",
          body: "这条内容用于确认上游 draft endpoint 成功返回真实平台草稿 ID 和 URL 后，任务目标直接进入外部草稿链接。",
          tags: ["draft", "upstream", "e2e"],
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

    if (task.status !== "succeeded") {
      throw new Error(`Upstream draft connector task did not succeed: ${task.status} ${JSON.stringify(task.results)}`);
    }

    for (const platform of platforms) {
      const target = task.results.find((item) => item.platform === platform);
      const expectedPrefix = `${platform}-upstream-${platform}-draft-`;
      const expectedUrlPrefix = `https://upstream.example.test/${platform}/`;
      if (
        !target ||
        target.status !== "succeeded" ||
        !target.remoteId?.startsWith(expectedPrefix) ||
        !target.url?.startsWith(expectedUrlPrefix)
      ) {
        throw new Error(`Upstream draft target did not expose external draft data for ${platform}: ${JSON.stringify(target)}`);
      }
    }

    if (upstream.requests.length !== platforms.length) {
      throw new Error(`Upstream draft service did not receive every platform draft: ${JSON.stringify(upstream.requests)}`);
    }

    for (const request of upstream.requests) {
      const detail = await requestAbsoluteJson(request.connectorDraftUrl);
      if (
        detail.state !== "ready" ||
        detail.externalDraftId !== `${request.platform}-upstream-${request.connectorDraftId}` ||
        detail.externalUrl !== `https://upstream.example.test/${request.platform}/${detail.externalDraftId}` ||
        detail.payload?.credential
      ) {
        throw new Error(`Upstream outbox detail is incorrect for ${request.platform}: ${JSON.stringify(detail)}`);
      }
    }

    const syncedTask = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (syncedTask.status !== "succeeded") {
      throw new Error(`Upstream draft sync did not preserve succeeded status: ${JSON.stringify(syncedTask)}`);
    }

    if (upstream.statusRequests.length !== platforms.length) {
      throw new Error(`Upstream status service did not receive every platform status query: ${JSON.stringify(upstream.statusRequests)}`);
    }

    for (const statusRequest of upstream.statusRequests) {
      const detail = await requestAbsoluteJson(statusRequest.connectorDraftUrl);
      if (
        detail.state !== "succeeded" ||
        detail.statusDetail !== `${statusRequest.platform} upstream draft published.` ||
        detail.payload?.credential ||
        statusRequest.hasCredential
      ) {
        throw new Error(`Upstream status sync did not persist correctly for ${statusRequest.platform}: ${JSON.stringify(detail)}`);
      }
    }

    return {
      taskId: created.id,
      finalStatus: syncedTask.status,
      targets: syncedTask.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
      })),
      upstreamRequests: upstream.requests.map((request) => ({
        platform: request.platform,
        connectorDraftId: request.connectorDraftId,
        statusCallbackUrl: request.statusCallbackUrl,
      })),
      upstreamStatusRequests: upstream.statusRequests.map((request) => ({
        platform: request.platform,
        connectorDraftId: request.connectorDraftId,
        remoteId: request.remoteId,
      })),
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    await upstream.close();
    apiBaseUrl = previousApiBaseUrl;
  }
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
const disabledPreflight = await runDisabledDraftPreflightCheck();
const offlinePreflight = await runOfflineDraftConnectorPreflightCheck();
const offlineUpstreamPreflight = await runOfflineUpstreamDraftPreflightCheck();
const offlineUpstreamRecovery = await runOfflineUpstreamDraftRecoveryCheck();
const upstreamForwarding = await runUpstreamDraftForwardingCheck();

const api = startService("api", ["apps/api/dist/main.js"], connectorEnv);
const worker = startService("worker", ["apps/worker/dist/main.js"], connectorEnv);
const draftConnector = startService("draft-connector", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

try {
  await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector");
  await waitForApi(api);
  const initialRuntime = await requestJson("/runtime/status");
  if (initialRuntime.draftConnector?.status !== "online" || initialRuntime.draftConnector?.outboxUrl !== `${connectorBaseUrl}/drafts`) {
    throw new Error(`API runtime did not report the draft connector as online: ${JSON.stringify(initialRuntime.draftConnector)}`);
  }

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

  const externalizedTargets = [];
  for (const platform of platforms) {
    const syncedTarget = task.results.find((item) => item.platform === platform);
    const connectorDraftId = syncedTarget?.remoteId;
    if (!connectorDraftId) {
      throw new Error(`Cannot externalize ${platform} draft without connector draft id: ${JSON.stringify(syncedTarget)}`);
    }

    const externalDraftId = `${platform}-external-draft-${created.id}`;
    const externalUrl = `https://draft.example.test/${platform}/${externalDraftId}`;
    const updatePayload = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts/${connectorDraftId}/status`, {
      method: "POST",
      headers: {
        authorization: "Bearer draft-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state: "ready",
        externalDraftId,
        url: externalUrl,
        detail: `${platform} external draft has been linked by the connector.`,
      }),
    });

    if (updatePayload.state !== "ready" || updatePayload.remoteId !== externalDraftId || updatePayload.url !== externalUrl) {
      throw new Error(`Draft connector status update returned an unexpected payload for ${platform}: ${JSON.stringify(updatePayload)}`);
    }

    const updatedDetail = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts/${connectorDraftId}`);
    if (updatedDetail.state !== "ready" || updatedDetail.externalDraftId !== externalDraftId || updatedDetail.externalUrl !== externalUrl) {
      throw new Error(`Draft connector detail did not persist external draft status for ${platform}: ${JSON.stringify(updatedDetail)}`);
    }
  }

  const externalSyncedTask = await requestJson(`/publish/tasks/${created.id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  for (const platform of platforms) {
    const afterExternalSync = externalSyncedTask.results.find((item) => item.platform === platform);
    const expectedRemoteId = `${platform}-external-draft-${created.id}`;
    const expectedUrl = `https://draft.example.test/${platform}/${expectedRemoteId}`;
    if (
      !afterExternalSync ||
      afterExternalSync.status !== "succeeded" ||
      afterExternalSync.remoteId !== expectedRemoteId ||
      afterExternalSync.url !== expectedUrl
    ) {
      throw new Error(`Draft connector sync did not expose external draft status for ${platform}: ${JSON.stringify(afterExternalSync)}`);
    }

    externalizedTargets.push({
      platform: afterExternalSync.platform,
      status: afterExternalSync.status,
      remoteId: afterExternalSync.remoteId,
      url: afterExternalSync.url,
    });
  }

  task = await requestJson(`/publish/tasks/${created.id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  for (const platform of platforms) {
    const resyncedTarget = task.results.find((item) => item.platform === platform);
    const expectedRemoteId = `${platform}-external-draft-${created.id}`;
    const expectedUrl = `https://draft.example.test/${platform}/${expectedRemoteId}`;
    if (
      !resyncedTarget ||
      resyncedTarget.status !== "succeeded" ||
      resyncedTarget.remoteId !== expectedRemoteId ||
      resyncedTarget.url !== expectedUrl
    ) {
      throw new Error(`Draft connector could not resolve status by external draft id for ${platform}: ${JSON.stringify(resyncedTarget)}`);
    }
  }

  const outboxIndex = await requestAbsoluteJson(`${connectorBaseUrl}/drafts?format=json`);
  const outboxHtml = await requestAbsoluteText(`${connectorBaseUrl}/drafts`);
  if (outboxIndex.items?.length !== platforms.length) {
    throw new Error(`Draft connector outbox index did not include every stored draft: ${JSON.stringify(outboxIndex)}`);
  }

  if (!outboxHtml.includes("Draft connector outbox") || !outboxHtml.includes("/zhihu/drafts/")) {
    throw new Error(`Draft connector outbox HTML did not render expected draft links: ${outboxHtml.slice(0, 500)}`);
  }

  const outboxPlatforms = new Set(outboxIndex.items.map((item) => item.platform));
  for (const platform of platforms) {
    if (!outboxPlatforms.has(platform)) {
      throw new Error(`Draft connector outbox index is missing ${platform}: ${JSON.stringify(outboxIndex)}`);
    }

    const platformOutbox = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts?format=json`);
    if (
      platformOutbox.items?.length !== 1 ||
      platformOutbox.items[0]?.platform !== platform ||
      platformOutbox.items[0]?.state !== "ready" ||
      !platformOutbox.items[0]?.externalUrl
    ) {
      throw new Error(`Draft connector platform outbox is incorrect for ${platform}: ${JSON.stringify(platformOutbox)}`);
    }
  }

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
    externalizedTargets,
    outboxIndex: outboxIndex.items.map((item) => ({
      platform: item.platform,
      draftId: item.draftId,
      title: item.title,
      state: item.state,
      externalUrl: item.externalUrl,
      url: item.url,
    })),
    draftConnector: {
      status: initialRuntime.draftConnector.status,
      outboxUrl: initialRuntime.draftConnector.outboxUrl,
    },
    disabledPreflight,
    offlinePreflight,
    offlineUpstreamPreflight,
    offlineUpstreamRecovery,
    upstreamForwarding,
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
