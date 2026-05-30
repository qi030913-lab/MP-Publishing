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

function startServiceWithEnv(name, args, cwd, env) {
  const stdoutPath = path.join(runtimeDir, `${name}-draft-e2e.out.log`);
  const stderrPath = path.join(runtimeDir, `${name}-draft-e2e.err.log`);
  const stdout = fs.openSync(stdoutPath, "w");
  const stderr = fs.openSync(stderrPath, "w");
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", stdout, stderr],
  });

  fs.closeSync(stdout);
  fs.closeSync(stderr);
  return { name, child, stdoutPath, stderrPath };
}

async function runNodeCommand(label, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}.\n${stdout}\n${stderr}`);
  }

  return { stdout, stderr };
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

async function startFakeUpstreamDraftService(port, expectedApiKey, options = {}) {
  const requests = [];
  const statusRequests = [];
  const baseUrl = `http://127.0.0.1:${port}`;

  function summarizeCredential(credential) {
    if (!credential || typeof credential !== "object") {
      return null;
    }

    return {
      platform: credential.platform,
      accountId: credential.accountId,
      authMode: credential.authMode,
      credentialRef: credential.credentialRef,
      hasAccessToken: Boolean(credential.accessToken),
      hasCookies: Boolean(credential.cookies),
      hasStorageStateJson: Boolean(credential.storageStateJson),
    };
  }

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
          credential: summarizeCredential(payload.credential),
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
        credential: summarizeCredential(payload.credential),
      });
      if (options.rejectDrafts) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            state: "needs_manual_action",
            detail: `${platform} upstream draft requires manual review.`,
            issues: [
              {
                code: `${platform.toUpperCase()}_UPSTREAM_POLICY_REVIEW`,
                message: `${platform} upstream draft requires creator-center review.`,
                severity: "warning",
              },
            ],
          }),
        );
        return;
      }

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

function expectedExecutionDraftId(platform, execution) {
  const targetSegment = String(execution.targetId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${platform}-draft-${targetSegment}-attempt-${execution.attemptCount}`;
}

function writeStoredDraftSeed(outboxDir, platform, storedDraft) {
  const platformOutboxDir = path.join(outboxDir, platform);
  fs.mkdirSync(platformOutboxDir, { recursive: true });
  fs.writeFileSync(path.join(platformOutboxDir, `${storedDraft.draftId}.json`), `${JSON.stringify(storedDraft, null, 2)}\n`);
}

function createDirectDraftPayload(platform, accountId, execution, title) {
  return {
    platform,
    accountId,
    execution,
    document: {
      id: `doc-${execution.taskId}`,
      title,
    },
    draft: {
      platform,
      title,
      summary: "Connector crash recovery verification.",
      body: "This draft verifies reserved connector outbox entries can still reach the upstream draft service.",
      hashtags: ["#draft", "#recovery"],
    },
    requestedAt: new Date().toISOString(),
  };
}

function createCleanServiceEnv(extraEnv = {}) {
  const env = { ...process.env };
  const isolatedKeys = new Set([
    "PORT",
    "PUBLISH_QUEUE_NAME",
    "ZHIHU_REAL_PUBLISH_ENABLED",
    "ZHIHU_DRAFT_ENDPOINT",
    "BILIBILI_REAL_PUBLISH_ENABLED",
    "BILIBILI_DRAFT_ENDPOINT",
    "XIAOHONGSHU_REAL_PUBLISH_ENABLED",
    "XIAOHONGSHU_DRAFT_ENDPOINT",
  ]);

  for (const key of Object.keys(env)) {
    if (isolatedKeys.has(key) || key.startsWith("DRAFT_CONNECTOR_")) {
      delete env[key];
    }
  }

  return {
    ...env,
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6380",
    ...extraEnv,
  };
}

function parseEnvFile(filePath) {
  const values = new Map();
  const content = fs.readFileSync(filePath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }

    values.set(match[1], value);
  }

  return values;
}

async function runDraftConnectorWorkspaceEnvCheck() {
  const connectorPort = await getFreePort();
  const upstreamPort = await getFreePort();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const workspaceEnvDir = path.join(runtimeDir, `draft-connector-workspace-env-e2e-${Date.now()}`);
  const outboxDir = path.join(workspaceEnvDir, "outbox");
  const connectorCwd = path.join(workspaceEnvDir, "apps", "draft-connector");
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;

  fs.rmSync(workspaceEnvDir, { recursive: true, force: true });
  fs.mkdirSync(connectorCwd, { recursive: true });
  fs.writeFileSync(path.join(workspaceEnvDir, "pnpm-workspace.yaml"), "packages: []\n");
  fs.writeFileSync(
    path.join(workspaceEnvDir, ".env"),
    [
      `PORT="${connectorPort}"`,
      `DRAFT_CONNECTOR_OUTBOX_DIR="outbox"`,
      `DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT="${upstreamBaseUrl}/zhihu/drafts"`,
      `DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT="${upstreamBaseUrl}/health"`,
      `DRAFT_CONNECTOR_ZHIHU_UPSTREAM_STATUS_ENDPOINT="${upstreamBaseUrl}/zhihu/status"`,
      `DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_API_KEY="env-upstream-secret"`,
      "",
    ].join("\n"),
  );

  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key === "PORT" || key.startsWith("DRAFT_CONNECTOR_")) {
      delete childEnv[key];
    }
  }

  const service = startServiceWithEnv(
    "draft-connector-workspace-env",
    [path.join(root, "apps/draft-connector/dist/main.js")],
    connectorCwd,
    childEnv,
  );

  try {
    const health = await waitForHealth(service, `${connectorBaseUrl}/health`, "Draft connector workspace env");
    const zhihuUpstream = health.upstreamDrafts?.find((item) => item.platform === "zhihu");

    if (
      health.outboxDir !== path.resolve(outboxDir) ||
      !zhihuUpstream?.draftEndpointConfigured ||
      !zhihuUpstream.statusEndpointConfigured ||
      zhihuUpstream.status !== "offline" ||
      zhihuUpstream.healthEndpoint !== `${upstreamBaseUrl}/health`
    ) {
      throw new Error(`Draft connector did not load workspace .env settings: ${JSON.stringify(health)}`);
    }

    return {
      status: health.status,
      outboxDir: health.outboxDir,
      zhihuUpstream: {
        status: zhihuUpstream.status,
        draftEndpointConfigured: zhihuUpstream.draftEndpointConfigured,
        statusEndpointConfigured: zhihuUpstream.statusEndpointConfigured,
      },
    };
  } finally {
    await stopService(service);
    fs.rmSync(workspaceEnvDir, { recursive: true, force: true });
  }
}

async function runDraftConnectorPublicBaseRuntimeCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const publicBaseUrl = "https://drafts.example.test/mp";
  const queueName = `mp-publishing-draft-public-base-e2e-${Date.now()}`;
  const outboxDir = path.join(runtimeDir, `draft-public-base-e2e-${Date.now()}`);
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];

  apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  fs.rmSync(outboxDir, { recursive: true, force: true });

  const api = startService("api-draft-public-base", ["apps/api/dist/main.js"], {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: publicBaseUrl,
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
  });
  const draftConnector = startService("draft-connector-public-base", ["apps/draft-connector/dist/main.js"], {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: publicBaseUrl,
  });

  try {
    await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector public base");
    await waitForApi(api);
    const runtime = await requestJson("/runtime/status");
    const contract = await requestAbsoluteJson(`${connectorBaseUrl}/contract`);

    if (
      runtime.draftConnector?.status !== "online" ||
      runtime.draftConnector?.baseUrl !== connectorBaseUrl ||
      runtime.draftConnector?.publicBaseUrl !== publicBaseUrl ||
      runtime.draftConnector?.outboxUrl !== `${publicBaseUrl}/drafts` ||
      runtime.draftConnector?.contractUrl !== `${publicBaseUrl}/contract` ||
      contract.version !== "draft-connector-upstream-v1" ||
      contract.connector?.contractUrl !== `${publicBaseUrl}/contract` ||
      platforms.some((platform) => !contract.supportedPlatforms?.includes(platform)) ||
      platforms.some((platform) => {
        const platformStatus = runtime.draftConnector?.platforms?.find((item) => item.platform === platform);
        return (
          platformStatus?.draftEndpoint !== `${connectorBaseUrl}/${platform}/drafts` ||
          platformStatus?.outboxUrl !== `${publicBaseUrl}/${platform}/drafts`
        );
      })
    ) {
      throw new Error(`Runtime did not expose public draft connector outbox URLs: ${JSON.stringify(runtime.draftConnector)}`);
    }

    return {
      status: runtime.draftConnector.status,
      baseUrl: runtime.draftConnector.baseUrl,
      publicBaseUrl: runtime.draftConnector.publicBaseUrl,
      outboxUrl: runtime.draftConnector.outboxUrl,
      contractUrl: runtime.draftConnector.contractUrl,
      contractVersion: contract.version,
      platformOutboxUrls: runtime.draftConnector.platforms.map((platformStatus) => ({
        platform: platformStatus.platform,
        outboxUrl: platformStatus.outboxUrl,
      })),
    };
  } finally {
    await Promise.all([stopService(api), stopService(draftConnector)]);
    fs.rmSync(outboxDir, { recursive: true, force: true });
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runUpstreamContractCheckScriptCheck() {
  const upstreamPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "upstream-secret");

  try {
    const command = await runNodeCommand("draft upstream contract checker", [
      path.join(root, "scripts/check-draft-upstream-contract.mjs"),
      "--platform",
      "zhihu",
      "--draft-endpoint",
      `${upstream.baseUrl}/zhihu/drafts`,
      "--status-endpoint",
      `${upstream.baseUrl}/zhihu/status`,
      "--health-endpoint",
      `${upstream.baseUrl}/health`,
      "--api-key",
      "upstream-secret",
      "--include-credential",
      "--status-include-credential",
    ]);
    const result = JSON.parse(command.stdout);

    if (
      !result.ok ||
      result.version !== "draft-connector-upstream-v1" ||
      result.platform !== "zhihu" ||
      result.health?.ok !== true ||
      result.draft?.state !== "ready" ||
      !result.draft?.remoteId?.startsWith("zhihu-upstream-") ||
      result.status?.state !== "succeeded" ||
      upstream.requests.length !== 1 ||
      upstream.statusRequests.length !== 1 ||
      !upstream.requests[0].hasCredential ||
      !upstream.statusRequests[0].hasCredential
    ) {
      throw new Error(
        `Draft upstream contract checker did not validate the fake upstream service: ${JSON.stringify({
          result,
          draftRequests: upstream.requests,
          statusRequests: upstream.statusRequests,
        })}`,
      );
    }

    return {
      platform: result.platform,
      draftRemoteId: result.draft.remoteId,
      statusState: result.status.state,
      healthStatus: result.health.status,
      draftCredentialForwarded: upstream.requests[0].hasCredential,
      statusCredentialForwarded: upstream.statusRequests[0].hasCredential,
    };
  } finally {
    await upstream.close();
  }
}

async function runUpstreamProxyEnablementCheck() {
  const upstreamPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "upstream-secret");
  const workspaceDir = path.join(runtimeDir, `draft-upstream-enable-e2e-${Date.now()}`);
  const envPath = path.join(workspaceDir, ".env");
  const connectorBaseUrl = "http://127.0.0.1:3010";

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  try {
    await runNodeCommand("enable draft upstream proxy", [
      path.join(root, "scripts/enable-draft-upstream-proxy.mjs"),
      "--target-env-file",
      envPath,
      "--proxy-base-url",
      upstream.baseUrl,
      "--connector-base-url",
      connectorBaseUrl,
      "--outbox-dir",
      "outbox",
      "--api-key",
      "upstream-secret",
      "--include-credential",
      "--status-include-credential",
      "--check",
    ]);

    const env = parseEnvFile(envPath);
    const enabledPlatforms = [];
    for (const platform of platforms) {
      const envPrefix = platform.toUpperCase();
      const upstreamPrefix = `DRAFT_CONNECTOR_${envPrefix}_UPSTREAM`;
      const expectedDraftEndpoint = `${upstream.baseUrl}/${platform}/drafts`;
      const expectedStatusEndpoint = `${upstream.baseUrl}/${platform}/status`;
      if (
        env.get(`${envPrefix}_REAL_PUBLISH_ENABLED`) !== "true" ||
        env.get(`${envPrefix}_DRAFT_INCLUDE_CREDENTIAL`) !== "true" ||
        env.get(`${envPrefix}_STATUS_INCLUDE_CREDENTIAL`) !== "true" ||
        env.get(`${upstreamPrefix}_DRAFT_ENDPOINT`) !== expectedDraftEndpoint ||
        env.get(`${upstreamPrefix}_STATUS_ENDPOINT`) !== expectedStatusEndpoint ||
        env.get(`${upstreamPrefix}_HEALTH_ENDPOINT`) !== `${upstream.baseUrl}/health` ||
        env.get(`${upstreamPrefix}_INCLUDE_CREDENTIAL`) !== "true" ||
        env.get(`${upstreamPrefix}_STATUS_INCLUDE_CREDENTIAL`) !== "true"
      ) {
        throw new Error(`Upstream enablement script wrote unexpected ${platform} config: ${JSON.stringify(Object.fromEntries(env))}`);
      }

      enabledPlatforms.push({
        platform,
        draftEndpoint: expectedDraftEndpoint,
        statusEndpoint: expectedStatusEndpoint,
      });
    }

    if (
      env.get("DRAFT_CONNECTOR_BASE_URL") !== connectorBaseUrl ||
      env.get("DRAFT_CONNECTOR_OUTBOX_DIR") !== "outbox" ||
      env.get("DRAFT_CONNECTOR_UPSTREAM_API_KEY") !== "upstream-secret" ||
      upstream.requests.length !== platforms.length ||
      upstream.statusRequests.length !== platforms.length ||
      upstream.requests.some((request) => !request.hasCredential) ||
      upstream.statusRequests.some((request) => !request.hasCredential)
    ) {
      throw new Error(
        `Upstream enablement script did not configure or check every platform: ${JSON.stringify({
          env: Object.fromEntries(env),
          draftRequests: upstream.requests,
          statusRequests: upstream.statusRequests,
        })}`,
      );
    }

    return {
      platforms: enabledPlatforms,
      draftCredentialPlatforms: upstream.requests.map((request) => request.platform).sort(),
      statusCredentialPlatforms: upstream.statusRequests.map((request) => request.platform).sort(),
    };
  } finally {
    await upstream.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function runLocalDraftEnablementCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const queueName = `mp-publishing-draft-enable-local-e2e-${Date.now()}`;
  const workspaceDir = path.join(runtimeDir, `draft-enable-local-e2e-${Date.now()}`);
  const envPath = path.join(workspaceDir, ".env");
  const outboxDir = path.join(workspaceDir, "outbox");
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];

  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "pnpm-workspace.yaml"), "packages: []\n");

  await runNodeCommand(
    "enable local draft connectors",
    [
      path.join(root, "scripts/enable-local-draft-connectors.mjs"),
      "--target-env-file",
      envPath,
    ],
    {
      LOCAL_DRAFT_ENV_FILE: "",
      LOCAL_DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
      LOCAL_DRAFT_OUTBOX_DIR: outboxDir,
    },
  );

  apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const api = startServiceWithEnv(
    "api-draft-enable-local",
    [path.join(root, "apps/api/dist/main.js")],
    workspaceDir,
    createCleanServiceEnv({ PORT: String(apiPort), PUBLISH_QUEUE_NAME: queueName }),
  );
  const worker = startServiceWithEnv(
    "worker-draft-enable-local",
    [path.join(root, "apps/worker/dist/main.js")],
    workspaceDir,
    createCleanServiceEnv({ PUBLISH_QUEUE_NAME: queueName }),
  );
  const draftConnector = startServiceWithEnv(
    "draft-connector-enable-local",
    [path.join(root, "apps/draft-connector/dist/main.js")],
    workspaceDir,
    createCleanServiceEnv({ PORT: String(connectorPort) }),
  );

  try {
    const health = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector enable-local");
    if (path.resolve(health.outboxDir) !== path.resolve(outboxDir)) {
      throw new Error(`Enable-local connector did not use generated outbox dir: ${JSON.stringify(health)}`);
    }

    await waitForApi(api);
    const runtime = await requestJson("/runtime/status");
    if (
      runtime.draftConnector?.status !== "online" ||
      platforms.some((platform) => {
        const platformStatus = runtime.draftConnector.platforms.find((item) => item.platform === platform);
        return (
          !platformStatus?.realPublishEnabled ||
          !platformStatus.draftReady ||
          platformStatus.draftCredentialRequired ||
          !Array.isArray(platformStatus.draftReadinessIssues) ||
          platformStatus.draftReadinessIssues.length > 0 ||
          platformStatus.draftEndpoint !== `${connectorBaseUrl}/${platform}/drafts` ||
          platformStatus.outboxUrl !== `${connectorBaseUrl}/${platform}/drafts`
        );
      })
    ) {
      throw new Error(`Enable-local runtime did not expose ready connector platforms: ${JSON.stringify(runtime.draftConnector)}`);
    }

    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });
    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for enable-local verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "本地启用脚本三平台草稿验证",
          summary: "验证 pnpm drafts:enable-local 生成的 .env 可以直接驱动三平台 connector 草稿。",
          body: "这条内容用于确认本地启用脚本不仅会改配置，也能让知乎、B站、小红书进入草稿连接器链路。",
          tags: ["draft", "enable-local", "e2e"],
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

    const storedDrafts = readDraftOutbox(outboxDir, platforms);
    if (
      task.status !== "succeeded" ||
      storedDrafts.length !== platforms.length ||
      platforms.some((platform) => task.results.find((item) => item.platform === platform)?.status !== "succeeded")
    ) {
      throw new Error(`Enable-local draft task did not create every platform draft: ${JSON.stringify({ task, storedDrafts })}`);
    }

    return {
      taskId: task.id,
      finalStatus: task.status,
      platforms: task.results.map((target) => target.platform),
      storedDrafts: storedDrafts.map((draft) => ({
        platform: draft.platform,
        draftId: draft.draftId,
      })),
      draftConnector: {
        status: runtime.draftConnector.status,
        outboxUrl: runtime.draftConnector.outboxUrl,
      },
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runDisabledDraftPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const preflightApiPort = await getFreePort();
  const preflightQueueName = `mp-publishing-draft-preflight-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  apiBaseUrl = `http://127.0.0.1:${preflightApiPort}`;
  const api = startService("api-draft-preflight", ["apps/api/dist/main.js"], {
    PORT: String(preflightApiPort),
    PUBLISH_QUEUE_NAME: preflightQueueName,
    DRAFT_CONNECTOR_BASE_URL: "",
    ZHIHU_REAL_PUBLISH_ENABLED: "false",
    ZHIHU_DRAFT_ENDPOINT: "",
    BILIBILI_REAL_PUBLISH_ENABLED: "false",
    BILIBILI_DRAFT_ENDPOINT: "",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "false",
    XIAOHONGSHU_DRAFT_ENDPOINT: "",
  });

  try {
    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for disabled preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台真实草稿预检验证",
          summary: "验证未启用连接器时不会把真实草稿任务排入 worker。",
          body: "这条内容用于确认 API 会在创建三平台真实草稿任务时做连接器预检。",
          tags: ["draft", "preflight", "e2e"],
        },
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !issueCodes.includes(`${platform.toUpperCase()}_REAL_PUBLISH_DISABLED`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_ENDPOINT_MISSING`)
        );
      })
    ) {
      throw new Error(`Draft preflight did not mark disabled connector target correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !issueCodes.includes(`${platform.toUpperCase()}_REAL_PUBLISH_DISABLED`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_ENDPOINT_MISSING`)
        );
      })
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

    if (
      platforms.some((platform) => {
        const platformStatus = runtimeAfterRetry.draftConnector.platforms.find((item) => item.platform === platform);
        const issueCodes = platformStatus?.draftReadinessIssues?.map((issue) => issue.code) ?? [];
        return (
          platformStatus?.draftReady !== false ||
          !issueCodes.includes(`${platform.toUpperCase()}_REAL_PUBLISH_DISABLED`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_ENDPOINT_MISSING`)
        );
      })
    ) {
      throw new Error(`Disabled runtime should expose draft readiness blockers: ${JSON.stringify(runtimeAfterRetry.draftConnector)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targets: retried.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        attemptCount: target.attemptCount,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await stopService(api);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runWorkerDraftConfigManualActionCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const queueName = `mp-publishing-draft-worker-config-e2e-${Date.now()}`;
  const outboxDir = path.join(runtimeDir, `draft-worker-config-e2e-${Date.now()}`);
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  fs.rmSync(outboxDir, { recursive: true, force: true });

  const apiEnv = createCleanServiceEnv({
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
  });
  const workerEnv = createCleanServiceEnv({
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: "",
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "false",
    ZHIHU_DRAFT_ENDPOINT: "",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_DRAFT_ENDPOINT: "",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_DRAFT_ENDPOINT: "",
  });
  const draftConnectorEnv = createCleanServiceEnv({
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
  });

  const api = startServiceWithEnv("api-draft-worker-config", ["apps/api/dist/main.js"], root, apiEnv);
  const worker = startServiceWithEnv("worker-draft-worker-config", ["apps/worker/dist/main.js"], root, workerEnv);
  const draftConnector = startServiceWithEnv(
    "draft-connector-worker-config",
    ["apps/draft-connector/dist/main.js"],
    root,
    draftConnectorEnv,
  );

  try {
    await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector");
    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const initialRuntime = await requestJson("/runtime/status");
    if (
      initialRuntime.draftConnector?.status !== "online" ||
      platforms.some((platform) => {
        const platformStatus = initialRuntime.draftConnector?.platforms?.find((item) => item.platform === platform);
        return platformStatus?.draftReady !== true;
      })
    ) {
      throw new Error(`Worker config drift check API preflight was not ready: ${JSON.stringify(initialRuntime.draftConnector)}`);
    }

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for worker config drift verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "Worker-side real draft config drift e2e",
          summary: "Verify queued real draft targets become manual action when worker-side connector config drifts.",
          body: "This content confirms API preflight is not the only guard for non-WeChat draft publishing.",
          tags: ["draft", "worker", "manual-action", "e2e"],
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

    const expectedIssueCodes = {
      zhihu: "ZHIHU_REAL_PUBLISH_DISABLED",
      bilibili: "BILIBILI_DRAFT_ENDPOINT_MISSING",
      xiaohongshu: "XIAOHONGSHU_DRAFT_ENDPOINT_MISSING",
    };

    if (
      task.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = task.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(expectedIssueCodes[platform]);
      })
    ) {
      throw new Error(`Worker config drift did not hold targets for manual action: ${JSON.stringify(task)}`);
    }

    const storedDrafts = readDraftOutbox(outboxDir, platforms);
    if (storedDrafts.length !== 0) {
      throw new Error(`Worker config drift should not create connector drafts: ${JSON.stringify(storedDrafts)}`);
    }

    if (runtime.queue.failed > 0 || runtime.queue.waiting > 0 || runtime.queue.active > 0) {
      throw new Error(`Worker config drift queue did not drain cleanly: ${JSON.stringify(runtime.queue)}`);
    }

    return {
      taskId: task.id,
      status: task.status,
      targets: task.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      outboxDraftCount: storedDrafts.length,
      queue: runtime.queue,
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    fs.rmSync(outboxDir, { recursive: true, force: true });
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runCredentialPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const preflightApiPort = await getFreePort();
  const preflightQueueName = `mp-publishing-draft-credential-preflight-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  apiBaseUrl = `http://127.0.0.1:${preflightApiPort}`;
  const api = startService("api-draft-credential-preflight", ["apps/api/dist/main.js"], {
    PORT: String(preflightApiPort),
    PUBLISH_QUEUE_NAME: preflightQueueName,
    DRAFT_CONNECTOR_BASE_URL: "",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_ENDPOINT: "http://127.0.0.1:9/zhihu/drafts",
    ZHIHU_DRAFT_INCLUDE_CREDENTIAL: "true",
    ZHIHU_APP_ID: "",
    ZHIHU_APP_SECRET: "",
    ZHIHU_ACCESS_TOKEN: "",
    ZHIHU_REFRESH_TOKEN: "",
    ZHIHU_COOKIES: "",
    ZHIHU_STORAGE_STATE_JSON: "",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_DRAFT_ENDPOINT: "http://127.0.0.1:9/bilibili/drafts",
    BILIBILI_DRAFT_INCLUDE_CREDENTIAL: "true",
    BILIBILI_APP_ID: "",
    BILIBILI_APP_SECRET: "",
    BILIBILI_ACCESS_TOKEN: "",
    BILIBILI_REFRESH_TOKEN: "",
    BILIBILI_COOKIES: "",
    BILIBILI_STORAGE_STATE_JSON: "",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_DRAFT_ENDPOINT: "http://127.0.0.1:9/xiaohongshu/drafts",
    XIAOHONGSHU_DRAFT_INCLUDE_CREDENTIAL: "true",
    XIAOHONGSHU_APP_ID: "",
    XIAOHONGSHU_APP_SECRET: "",
    XIAOHONGSHU_ACCESS_TOKEN: "",
    XIAOHONGSHU_REFRESH_TOKEN: "",
    XIAOHONGSHU_COOKIES: "",
    XIAOHONGSHU_STORAGE_STATE_JSON: "",
  });

  try {
    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length || accounts.some((account) => account.credentialStatus !== "missing")) {
      throw new Error(`Credential preflight accounts should be missing credentials: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "三平台凭证缺失预检验证",
          summary: "验证开启凭证转发但账号凭证缺失时不会入队真实草稿任务。",
          body: "这条内容用于确认官方 API 代理需要凭证时，API 会先要求人工补齐凭证，而不是让 worker 进入必然失败的草稿创建。",
          tags: ["draft", "credential", "preflight", "e2e"],
        },
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });

    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CREDENTIAL_MISSING`);
      })
    ) {
      throw new Error(`Credential preflight did not hold missing credential targets correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CREDENTIAL_MISSING`);
      })
    ) {
      throw new Error(`Credential preflight retry did not keep targets on manual action: ${JSON.stringify(retried)}`);
    }

    if (
      runtimeAfterRetry.queue.waiting > 0 ||
      runtimeAfterRetry.queue.active > 0 ||
      runtimeAfterRetry.queue.delayed > 0 ||
      runtimeAfterRetry.queue.failed > 0
    ) {
      throw new Error(`Credential preflight retry should not enqueue work: ${JSON.stringify(runtimeAfterRetry.queue)}`);
    }

    if (
      platforms.some((platform) => {
        const platformStatus = runtimeAfterRetry.draftConnector.platforms.find((item) => item.platform === platform);
        return platformStatus?.draftCredentialRequired !== true || platformStatus?.draftReady !== false;
      })
    ) {
      throw new Error(`Credential preflight runtime should expose credential requirements: ${JSON.stringify(runtimeAfterRetry.draftConnector)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targets: retried.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        attemptCount: target.attemptCount,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
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
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  apiBaseUrl = `http://127.0.0.1:${preflightApiPort}`;
  const api = startService("api-draft-offline", ["apps/api/dist/main.js"], {
    PORT: String(preflightApiPort),
    PUBLISH_QUEUE_NAME: preflightQueueName,
    DRAFT_CONNECTOR_BASE_URL: `http://127.0.0.1:${offlineConnectorPort}`,
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_ENDPOINT: "",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_DRAFT_ENDPOINT: "",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_DRAFT_ENDPOINT: "",
  });

  try {
    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for offline connector preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "非公众号平台真实草稿离线连接器预检验证",
          summary: "验证本地连接器离线时不会把真实草稿任务排入 worker。",
          body: "这条内容用于确认 API 会在创建三平台真实草稿任务时探测本地 draft connector health。",
          tags: ["draft", "offline", "e2e"],
        },
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });

    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CONNECTOR_OFFLINE`);
      })
    ) {
      throw new Error(`Draft preflight did not hold an offline connector target correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CONNECTOR_OFFLINE`);
      })
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
      targets: retried.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        attemptCount: target.attemptCount,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await stopService(api);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runExplicitLocalDraftEndpointPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const offlineConnectorPort = await getFreePort();
  const queueName = `mp-publishing-draft-explicit-local-e2e-${Date.now()}`;
  const connectorBaseUrl = `http://127.0.0.1:${offlineConnectorPort}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const api = startService("api-draft-explicit-local", ["apps/api/dist/main.js"], {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: "",
    DRAFT_CONNECTOR_HEALTH_URL: "",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_ENDPOINT: `${connectorBaseUrl}/zhihu/drafts`,
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_DRAFT_ENDPOINT: `${connectorBaseUrl}/bilibili/drafts`,
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_DRAFT_ENDPOINT: `${connectorBaseUrl}/xiaohongshu/drafts`,
  });

  try {
    await waitForApi(api);
    const initialRuntime = await requestJson("/runtime/status");
    if (
      initialRuntime.draftConnector?.status !== "offline" ||
      initialRuntime.draftConnector?.healthUrl !== `${connectorBaseUrl}/health` ||
      platforms.some((platform) => {
        const platformStatus = initialRuntime.draftConnector.platforms.find((item) => item.platform === platform);
        return platformStatus?.draftReady !== false;
      })
    ) {
      throw new Error(`Explicit local draft endpoints did not infer connector health: ${JSON.stringify(initialRuntime.draftConnector)}`);
    }

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for explicit local endpoint preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "三平台显式本地 endpoint 离线预检验证",
          summary: "验证显式配置本地 connector endpoint 时仍会探测 /health。",
          body: "这条内容用于确认未设置 DRAFT_CONNECTOR_BASE_URL 但使用本地 /:platform/drafts endpoint 时，API 仍会在入队前发现连接器离线。",
          tags: ["draft", "explicit-endpoint", "offline", "e2e"],
        },
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });

    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CONNECTOR_OFFLINE`);
      })
    ) {
      throw new Error(`Explicit local endpoint preflight did not hold offline connector targets: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CONNECTOR_OFFLINE`);
      })
    ) {
      throw new Error(`Explicit local endpoint retry did not keep targets on manual action: ${JSON.stringify(retried)}`);
    }

    if (
      runtimeAfterRetry.queue.waiting > 0 ||
      runtimeAfterRetry.queue.active > 0 ||
      runtimeAfterRetry.queue.delayed > 0 ||
      runtimeAfterRetry.queue.failed > 0
    ) {
      throw new Error(`Explicit local endpoint retry should not enqueue work: ${JSON.stringify(runtimeAfterRetry.queue)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      healthUrl: initialRuntime.draftConnector.healthUrl,
      targets: retried.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        attemptCount: target.attemptCount,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await stopService(api);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runExplicitLocalDraftEndpointStatusSyncCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-explicit-local-status-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-explicit-local-status-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const serviceEnv = {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: "",
    DRAFT_CONNECTOR_HEALTH_URL: "",
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_ENDPOINT: `${connectorBaseUrl}/zhihu/drafts`,
    ZHIHU_STATUS_ENDPOINT: "",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_DRAFT_ENDPOINT: `${connectorBaseUrl}/bilibili/drafts`,
    BILIBILI_STATUS_ENDPOINT: "",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_DRAFT_ENDPOINT: `${connectorBaseUrl}/xiaohongshu/drafts`,
    XIAOHONGSHU_STATUS_ENDPOINT: "",
  };
  const draftConnectorEnv = {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_BASE_URL: "",
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
  };

  const api = startService("api-draft-explicit-local-status", ["apps/api/dist/main.js"], serviceEnv);
  const worker = startService("worker-draft-explicit-local-status", ["apps/worker/dist/main.js"], serviceEnv);
  const draftConnector = startService(
    "draft-connector-explicit-local-status",
    ["apps/draft-connector/dist/main.js"],
    draftConnectorEnv,
  );

  try {
    await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector explicit local status");
    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const initialRuntime = await requestJson("/runtime/status");
    if (
      initialRuntime.draftConnector?.status !== "online" ||
      initialRuntime.draftConnector?.healthUrl !== `${connectorBaseUrl}/health` ||
      platforms.some((platform) => {
        const platformStatus = initialRuntime.draftConnector.platforms.find((item) => item.platform === platform);
        return (
          !platformStatus?.draftReady ||
          platformStatus?.draftEndpoint !== `${connectorBaseUrl}/${platform}/drafts` ||
          platformStatus?.statusEndpoint !== `${connectorBaseUrl}/${platform}/status`
        );
      })
    ) {
      throw new Error(`Explicit local draft endpoints did not infer status endpoints: ${JSON.stringify(initialRuntime.draftConnector)}`);
    }

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for explicit local status sync verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "Explicit local status sync e2e",
          summary: "Verify explicit local draft endpoints infer status endpoints without DRAFT_CONNECTOR_BASE_URL.",
          body: "This content confirms Zhihu, Bilibili, and Xiaohongshu can create local connector drafts and then sync status through inferred status endpoints.",
          tags: ["draft", "explicit-endpoint", "status", "e2e"],
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

    if (
      task.status !== "succeeded" ||
      platforms.some((platform) => {
        const target = task.results.find((item) => item.platform === platform);
        return (
          target?.status !== "succeeded" ||
          !target.remoteId?.startsWith(`${platform}-draft-`) ||
          !target.url?.startsWith(`${connectorBaseUrl}/${platform}/drafts/${platform}-draft-`)
        );
      })
    ) {
      throw new Error(`Explicit local endpoint draft creation did not succeed: ${JSON.stringify(task)}`);
    }

    const synced = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (
      synced.status !== "succeeded" ||
      platforms.some((platform) => {
        const target = synced.results.find((item) => item.platform === platform);
        return (
          target?.status !== "succeeded" ||
          !target.remoteId?.startsWith(`${platform}-draft-`) ||
          !target.url?.startsWith(`${connectorBaseUrl}/${platform}/drafts/${platform}-draft-`)
        );
      })
    ) {
      throw new Error(`Explicit local endpoint inferred status sync did not succeed: ${JSON.stringify(synced)}`);
    }

    return {
      taskId: created.id,
      finalStatus: synced.status,
      healthUrl: initialRuntime.draftConnector.healthUrl,
      inferredStatusEndpoints: platforms.map((platform) => {
        const platformStatus = initialRuntime.draftConnector.platforms.find((item) => item.platform === platform);
        return {
          platform,
          statusEndpoint: platformStatus.statusEndpoint,
        };
      }),
      targets: synced.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
      })),
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runCredentialForwardingMismatchPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const apiPort = await getFreePort();
  const connectorPort = await getFreePort();
  const upstreamPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "upstream-secret");
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-credential-mismatch-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-credential-mismatch-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  fs.rmSync(outboxDir, { recursive: true, force: true });

  const api = startService("api-draft-credential-mismatch", ["apps/api/dist/main.js"], {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_INCLUDE_CREDENTIAL: "",
    BILIBILI_DRAFT_INCLUDE_CREDENTIAL: "",
    XIAOHONGSHU_DRAFT_INCLUDE_CREDENTIAL: "",
  });
  const draftConnector = startService("draft-connector-credential-mismatch", ["apps/draft-connector/dist/main.js"], {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_INCLUDE_CREDENTIAL: "true",
  });

  try {
    const connectorHealth = await waitForHealth(
      draftConnector,
      `${connectorBaseUrl}/health`,
      "Draft connector credential forwarding mismatch",
    );
    if (
      platforms.some(
        (platform) =>
          !connectorHealth.upstreamDrafts?.some(
            (item) =>
              item.platform === platform &&
              item.draftEndpointConfigured &&
              item.credentialForwardingEnabled &&
              item.status === "online",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not expose upstream credential requirements: ${JSON.stringify(connectorHealth)}`);
    }

    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for credential mismatch preflight verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "三平台凭证转发配置不一致预检验证",
          summary: "验证 connector 上游要求凭证但 adapter 未开启凭证转发时不会入队。",
          body: "这条内容用于确认两级凭证转发开关必须一致，否则官方 API 代理会收到无凭证请求。",
          tags: ["draft", "credential", "mismatch", "e2e"],
        },
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });

    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CREDENTIAL_FORWARDING_DISABLED`)
        );
      })
    ) {
      throw new Error(`Credential mismatch preflight did not hold targets correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CREDENTIAL_FORWARDING_DISABLED`)
        );
      })
    ) {
      throw new Error(`Credential mismatch preflight retry did not keep targets on manual action: ${JSON.stringify(retried)}`);
    }

    if (
      runtimeAfterRetry.queue.waiting > 0 ||
      runtimeAfterRetry.queue.active > 0 ||
      runtimeAfterRetry.queue.delayed > 0 ||
      runtimeAfterRetry.queue.failed > 0 ||
      upstream.requests.length > 0
    ) {
      throw new Error(
        `Credential mismatch preflight should not enqueue work or call upstream: ${JSON.stringify({
          queue: runtimeAfterRetry.queue,
          upstreamRequests: upstream.requests,
        })}`,
      );
    }

    if (
      platforms.some((platform) => {
        const platformStatus = runtimeAfterRetry.draftConnector.platforms.find((item) => item.platform === platform);
        const issueCodes = platformStatus?.draftReadinessIssues?.map((issue) => issue.code) ?? [];
        return (
          platformStatus?.draftReady !== false ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CREDENTIAL_FORWARDING_DISABLED`)
        );
      })
    ) {
      throw new Error(`Credential mismatch runtime should expose draft readiness blockers: ${JSON.stringify(runtimeAfterRetry.draftConnector)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targets: retried.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        attemptCount: target.attemptCount,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      queue: runtimeAfterRetry.queue,
    };
  } finally {
    await Promise.all([stopService(api), stopService(draftConnector)]);
    await upstream.close();
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
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const api = startService("api-draft-offline-upstream", ["apps/api/dist/main.js"], {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
  });
  const draftConnector = startService("draft-connector-offline-upstream", ["apps/draft-connector/dist/main.js"], {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
  });

  try {
    const connectorHealth = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector offline upstream");
    if (
      platforms.some(
        (platform) =>
          !connectorHealth.upstreamDrafts?.some(
            (item) => item.platform === platform && item.draftEndpointConfigured && item.status === "offline",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not expose offline upstream status: ${JSON.stringify(connectorHealth)}`);
    }

    await waitForApi(api);
    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for offline upstream preflight verification: ${JSON.stringify(accountsResponse.items)}`);
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
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_DRAFT_CONNECTOR_OFFLINE`);
      })
    ) {
      throw new Error(`Draft preflight did not hold an offline upstream target correctly: ${JSON.stringify(created)}`);
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runtimeAfterRetry = await requestJson("/runtime/status");

    if (
      retried.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_DRAFT_CONNECTOR_OFFLINE`);
      })
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

    if (
      platforms.some((platform) => {
        const platformStatus = runtimeAfterRetry.draftConnector.platforms.find((item) => item.platform === platform);
        const issueCodes = platformStatus?.draftReadinessIssues?.map((issue) => issue.code) ?? [];
        return (
          platformStatus?.draftReady !== false ||
          platformStatus?.upstreamDraftStatus !== "offline" ||
          !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_DRAFT_CONNECTOR_OFFLINE`)
        );
      })
    ) {
      throw new Error(`Offline upstream runtime should mark draft targets as not ready: ${JSON.stringify(runtimeAfterRetry.draftConnector)}`);
    }

    return {
      taskId: created.id,
      status: retried.status,
      targets: retried.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        attemptCount: target.attemptCount,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      upstreamStatuses: connectorHealth.upstreamDrafts
        ?.filter((item) => platforms.includes(item.platform))
        .map((item) => ({ platform: item.platform, status: item.status })),
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
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const serviceEnv = {
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
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstreamBaseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstreamBaseUrl}/health`,
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
    if (
      platforms.some(
        (platform) =>
          !offlineHealth.upstreamDrafts?.some(
            (item) => item.platform === platform && item.draftEndpointConfigured && item.status === "offline",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not start with offline upstream status: ${JSON.stringify(offlineHealth)}`);
    }

    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for upstream recovery verification: ${JSON.stringify(accountsResponse.items)}`);
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
        platforms,
        accountIds: accounts.map((account) => account.id),
        toneMode: "keep",
        preserveOriginal: true,
      }),
    });
    if (
      created.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = created.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return target?.status !== "needs_manual_action" || !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_DRAFT_CONNECTOR_OFFLINE`);
      })
    ) {
      throw new Error(`Upstream recovery precondition did not hold the target: ${JSON.stringify(created)}`);
    }

    upstream = await startFakeUpstreamDraftService(upstreamPort, "upstream-secret");
    for (let i = 0; i < 20; i += 1) {
      await delay(300);
      const onlineHealth = await requestAbsoluteJson(`${connectorBaseUrl}/health`);
      if (
        platforms.every((platform) =>
          onlineHealth.upstreamDrafts?.some(
            (item) => item.platform === platform && item.draftEndpointConfigured && item.status === "online",
          ),
        )
      ) {
        break;
      }

      if (i === 19) {
        throw new Error(`Draft connector health did not recover after upstream started: ${JSON.stringify(onlineHealth)}`);
      }
    }

    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (platforms.some((platform) => retried.results.find((item) => item.platform === platform)?.status !== "queued")) {
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

    if (
      task.status !== "succeeded" ||
      platforms.some((platform) => {
        const target = task.results.find((item) => item.platform === platform);
        return (
          target?.status !== "succeeded" ||
          !target.remoteId?.startsWith(`${platform}-upstream-${platform}-draft-`) ||
          !target.url?.startsWith(`https://upstream.example.test/${platform}/`)
        );
      })
    ) {
      throw new Error(`Recovered upstream draft target did not succeed: ${JSON.stringify(task)}`);
    }

    if (upstream.requests.length !== platforms.length) {
      throw new Error(`Recovered upstream draft service did not receive every platform draft: ${JSON.stringify(upstream.requests)}`);
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
      targets: task.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
      })),
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

    const resumedDrafts = [];
    const freshInFlightDrafts = [];
    const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    for (const platform of platforms) {
      const account = accounts.find((item) => item.platform === platform);
      const execution = {
        taskId: `resume-${created.id}`,
        targetId: `target-resume-${platform}-${Date.now()}`,
        attemptCount: 1,
      };
      const payload = createDirectDraftPayload(platform, account.id, execution, `Resume stale ${platform} upstream draft`);
      const draftId = expectedExecutionDraftId(platform, execution);
      writeStoredDraftSeed(upstreamOutboxDir, platform, {
        draftId,
        platform,
        accountId: account.id,
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        state: "publishing",
        statusDetail: `${platform} draft is being forwarded to an upstream draft service.`,
        payload,
      });

      const resumed = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer draft-secret",
        },
        body: JSON.stringify(payload),
      });
      const expectedRemoteId = `${platform}-upstream-${draftId}`;
      if (
        resumed.remoteId !== expectedRemoteId ||
        resumed.url !== `https://upstream.example.test/${platform}/${expectedRemoteId}`
      ) {
        throw new Error(`Stale upstream draft reservation was not resumed for ${platform}: ${JSON.stringify(resumed)}`);
      }

      const detail = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts/${draftId}`);
      if (detail.state !== "ready" || detail.externalDraftId !== expectedRemoteId) {
        throw new Error(`Resumed upstream draft did not persist external data for ${platform}: ${JSON.stringify(detail)}`);
      }

      resumedDrafts.push({ platform, draftId, remoteId: resumed.remoteId });
    }

    const requestCountBeforeFreshInFlight = upstream.requests.length;
    for (const platform of platforms) {
      const account = accounts.find((item) => item.platform === platform);
      const execution = {
        taskId: `fresh-${created.id}`,
        targetId: `target-fresh-${platform}-${Date.now()}`,
        attemptCount: 1,
      };
      const payload = createDirectDraftPayload(platform, account.id, execution, `Fresh in-flight ${platform} upstream draft`);
      const draftId = expectedExecutionDraftId(platform, execution);
      const timestamp = new Date().toISOString();
      writeStoredDraftSeed(upstreamOutboxDir, platform, {
        draftId,
        platform,
        accountId: account.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        state: "publishing",
        statusDetail: `${platform} draft is being forwarded to an upstream draft service.`,
        payload,
      });

      const reused = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer draft-secret",
        },
        body: JSON.stringify(payload),
      });
      if (reused.remoteId !== draftId || !reused.url?.startsWith(`${connectorBaseUrl}/${platform}/drafts/`)) {
        throw new Error(`Fresh upstream draft reservation should be reused without forwarding for ${platform}: ${JSON.stringify(reused)}`);
      }

      freshInFlightDrafts.push({ platform, draftId, remoteId: reused.remoteId });
    }

    if (upstream.requests.length !== requestCountBeforeFreshInFlight) {
      throw new Error(
        `Fresh upstream draft reservations should not be forwarded again: ${JSON.stringify({
          before: requestCountBeforeFreshInFlight,
          after: upstream.requests.length,
          requests: upstream.requests,
        })}`,
      );
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
      resumedDrafts,
      freshInFlightDrafts,
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    await upstream.close();
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runUpstreamDraftRejectionManualActionCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const upstreamPort = await getFreePort();
  const connectorPort = await getFreePort();
  const apiPort = await getFreePort();
  const upstreamOptions = { rejectDrafts: true };
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "reject-upstream-secret", upstreamOptions);
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-upstream-reject-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-upstream-reject-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(outboxDir, { recursive: true, force: true });
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
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "reject-upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
  };

  const api = startService("api-draft-upstream-reject", ["apps/api/dist/main.js"], connectorEnv);
  const worker = startService("worker-draft-upstream-reject", ["apps/worker/dist/main.js"], connectorEnv);
  const draftConnector = startService("draft-connector-upstream-reject", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

  try {
    const upstreamHealth = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector upstream reject");
    if (
      platforms.some(
        (platform) =>
          !upstreamHealth.upstreamDrafts?.some(
            (item) => item.platform === platform && item.draftEndpointConfigured && item.status === "online",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not report rejecting upstream as online: ${JSON.stringify(upstreamHealth)}`);
    }

    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for upstream rejection verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "Upstream rejection manual action e2e",
          summary: "Verify connector/upstream draft rejection is surfaced as manual action.",
          body: "This content confirms real draft connector execution issues stay visible on the target instead of becoming a generic failed job.",
          tags: ["draft", "upstream", "manual-action", "e2e"],
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

    if (
      task.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = task.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !issueCodes.includes(`${platform.toUpperCase()}_DRAFT_CONNECTOR_REJECTED`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_DRAFT_REJECTED`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_POLICY_REVIEW`)
        );
      })
    ) {
      throw new Error(`Upstream draft rejection was not held for manual action: ${JSON.stringify(task)}`);
    }

    if (upstream.requests.length !== platforms.length) {
      throw new Error(`Rejecting upstream did not receive every platform draft: ${JSON.stringify(upstream.requests)}`);
    }

    for (const request of upstream.requests) {
      const target = task.results.find((item) => item.platform === request.platform);
      if (
        target?.remoteId !== request.connectorDraftId ||
        target?.url !== request.connectorDraftUrl
      ) {
        throw new Error(`Rejected upstream target did not keep local draft URL for ${request.platform}: ${JSON.stringify(target)}`);
      }

      const detail = await requestAbsoluteJson(target.url);
      if (detail.state !== "needs_manual_action" || detail.payload?.credential) {
        throw new Error(`Rejected upstream outbox detail is incorrect for ${request.platform}: ${JSON.stringify(detail)}`);
      }
    }

    const syncedRejected = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const resyncedRejected = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    for (const platform of platforms) {
      const beforeSync = task.results.find((item) => item.platform === platform);
      const afterSync = syncedRejected.results.find((item) => item.platform === platform);
      const afterSecondSync = resyncedRejected.results.find((item) => item.platform === platform);
      if (
        !beforeSync ||
        afterSync?.status !== "needs_manual_action" ||
        afterSecondSync?.status !== "needs_manual_action" ||
        afterSync.remoteId !== beforeSync.remoteId ||
        afterSecondSync.remoteId !== beforeSync.remoteId ||
        afterSync.url !== beforeSync.url ||
        afterSecondSync.url !== beforeSync.url ||
        afterSync.issues.length !== beforeSync.issues.length ||
        afterSecondSync.issues.length !== beforeSync.issues.length
      ) {
        throw new Error(`Rejected upstream status sync should preserve state and dedupe issues for ${platform}: ${JSON.stringify({
          beforeSync,
          afterSync,
          afterSecondSync,
        })}`);
      }
    }

    upstreamOptions.rejectDrafts = false;
    const retried = await requestJson(`/publish/tasks/${created.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (
      platforms.some((platform) => {
        const target = retried.results.find((item) => item.platform === platform);
        return target?.status !== "queued" || target.remoteId || target.url;
      })
    ) {
      throw new Error(`Rejected upstream retry should enqueue every platform after upstream recovery: ${JSON.stringify(retried)}`);
    }

    let recoveredTask = retried;
    for (let i = 0; i < 50; i += 1) {
      await delay(600);
      recoveredTask = await requestJson(`/publish/tasks/${created.id}`);
      if (!["running", "queued"].includes(recoveredTask.status)) {
        break;
      }
    }

    if (
      recoveredTask.status !== "succeeded" ||
      platforms.some((platform) => {
        const target = recoveredTask.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "succeeded" ||
          !target.remoteId?.startsWith(`${platform}-upstream-${platform}-draft-`) ||
          !target.url?.startsWith(`https://upstream.example.test/${platform}/`) ||
          issueCodes.some((code) => code.endsWith("_DRAFT_CONNECTOR_REJECTED") || code.endsWith("_UPSTREAM_DRAFT_REJECTED"))
        );
      })
    ) {
      throw new Error(`Recovered upstream draft retry did not succeed cleanly: ${JSON.stringify(recoveredTask)}`);
    }

    if (upstream.requests.length !== platforms.length * 2) {
      throw new Error(`Recovered upstream did not receive a second draft request for every platform: ${JSON.stringify(upstream.requests)}`);
    }

    const runtimeAfterRejection = await requestJson("/runtime/status");
    if (
      runtimeAfterRejection.queue.waiting > 0 ||
      runtimeAfterRejection.queue.active > 0 ||
      runtimeAfterRejection.queue.delayed > 0 ||
      runtimeAfterRejection.queue.failed > 0
    ) {
      throw new Error(`Rejected upstream draft left unexpected queue work: ${JSON.stringify(runtimeAfterRejection.queue)}`);
    }

    return {
      taskId: created.id,
      rejectedStatus: task.status,
      finalStatus: recoveredTask.status,
      targets: task.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      syncedRejectedTargets: syncedRejected.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      recoveredTargets: recoveredTask.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      upstreamRequests: upstream.requests.map((request) => ({
        platform: request.platform,
        connectorDraftId: request.connectorDraftId,
      })),
      queue: runtimeAfterRejection.queue,
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    await upstream.close();
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runStatusCredentialForwardingMismatchSyncCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const upstreamPort = await getFreePort();
  const connectorPort = await getFreePort();
  const apiPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "status-mismatch-upstream-secret");
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-status-credential-mismatch-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-status-credential-mismatch-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const connectorEnv = {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_STATUS_INCLUDE_CREDENTIAL: "",
    BILIBILI_STATUS_INCLUDE_CREDENTIAL: "",
    XIAOHONGSHU_STATUS_INCLUDE_CREDENTIAL: "",
  };
  const draftConnectorEnv = {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "status-mismatch-upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/zhihu/status`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_STATUS_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/bilibili/status`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_STATUS_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/status`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_STATUS_INCLUDE_CREDENTIAL: "true",
  };

  const api = startService("api-draft-status-credential-mismatch", ["apps/api/dist/main.js"], connectorEnv);
  const worker = startService("worker-draft-status-credential-mismatch", ["apps/worker/dist/main.js"], connectorEnv);
  const draftConnector = startService(
    "draft-connector-status-credential-mismatch",
    ["apps/draft-connector/dist/main.js"],
    draftConnectorEnv,
  );

  try {
    const connectorHealth = await waitForHealth(
      draftConnector,
      `${connectorBaseUrl}/health`,
      "Draft connector status credential mismatch",
    );
    if (
      platforms.some(
        (platform) =>
          !connectorHealth.upstreamDrafts?.some(
            (item) =>
              item.platform === platform &&
              item.statusEndpointConfigured &&
              item.statusCredentialForwardingEnabled &&
              item.status === "online",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not expose upstream status credential requirements: ${JSON.stringify(connectorHealth)}`);
    }

    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for status credential mismatch verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "Status credential mismatch e2e",
          summary: "Verify status sync is held before forwarding an uncredentialed upstream request.",
          body: "This content confirms status sync credential forwarding must be enabled on both API and connector hops.",
          tags: ["draft", "status", "credential", "e2e"],
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

    if (task.status !== "succeeded" || upstream.requests.length !== platforms.length) {
      throw new Error(`Status credential mismatch setup did not create upstream drafts: ${JSON.stringify({ task, upstreamRequests: upstream.requests })}`);
    }

    const synced = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (
      synced.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = synced.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !target.remoteId?.startsWith(`${platform}-upstream-${platform}-draft-`) ||
          !target.url?.startsWith(`https://upstream.example.test/${platform}/`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_STATUS_CREDENTIAL_FORWARDING_DISABLED`)
        );
      })
    ) {
      throw new Error(`Status credential mismatch sync was not held for manual action: ${JSON.stringify(synced)}`);
    }

    if (upstream.statusRequests.length > 0) {
      throw new Error(`Status credential mismatch should not call upstream status: ${JSON.stringify(upstream.statusRequests)}`);
    }

    return {
      taskId: created.id,
      finalStatus: synced.status,
      targets: synced.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      upstreamDraftRequests: upstream.requests.map((request) => request.platform).sort(),
      upstreamStatusRequests: upstream.statusRequests.length,
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    await upstream.close();
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runOfflineUpstreamStatusSyncPreflightCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const upstreamPort = await getFreePort();
  const connectorPort = await getFreePort();
  const apiPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "status-offline-upstream-secret");
  let upstreamClosed = false;
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-status-offline-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-status-offline-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  fs.rmSync(outboxDir, { recursive: true, force: true });
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
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "status-offline-upstream-secret",
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

  const api = startService("api-draft-status-offline", ["apps/api/dist/main.js"], connectorEnv);
  const worker = startService("worker-draft-status-offline", ["apps/worker/dist/main.js"], connectorEnv);
  const draftConnector = startService("draft-connector-status-offline", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

  try {
    const connectorHealth = await waitForHealth(
      draftConnector,
      `${connectorBaseUrl}/health`,
      "Draft connector upstream status offline",
    );
    if (
      platforms.some(
        (platform) =>
          !connectorHealth.upstreamDrafts?.some(
            (item) => item.platform === platform && item.statusEndpointConfigured && item.status === "online",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not expose online upstream status services: ${JSON.stringify(connectorHealth)}`);
    }

    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length) {
      throw new Error(`Missing demo accounts for offline upstream status verification: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "Offline upstream status e2e",
          summary: "Verify status sync is held when the upstream status service becomes unavailable.",
          body: "This content confirms manual sync does not call an offline upstream status service after drafts have been created.",
          tags: ["draft", "status", "offline", "e2e"],
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

    if (task.status !== "succeeded" || upstream.requests.length !== platforms.length) {
      throw new Error(`Offline upstream status setup did not create upstream drafts: ${JSON.stringify({ task, upstreamRequests: upstream.requests })}`);
    }

    await upstream.close();
    upstreamClosed = true;

    const offlineHealth = await requestAbsoluteJson(`${connectorBaseUrl}/health`);
    if (
      platforms.some(
        (platform) =>
          !offlineHealth.upstreamDrafts?.some(
            (item) => item.platform === platform && item.statusEndpointConfigured && item.status === "offline",
          ),
      )
    ) {
      throw new Error(`Draft connector health did not expose offline upstream status services: ${JSON.stringify(offlineHealth)}`);
    }

    const synced = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (
      synced.status !== "needs_manual_action" ||
      platforms.some((platform) => {
        const target = synced.results.find((item) => item.platform === platform);
        const issueCodes = target?.issues?.map((issue) => issue.code) ?? [];
        return (
          target?.status !== "needs_manual_action" ||
          !target.remoteId?.startsWith(`${platform}-upstream-${platform}-draft-`) ||
          !target.url?.startsWith(`https://upstream.example.test/${platform}/`) ||
          !issueCodes.includes(`${platform.toUpperCase()}_UPSTREAM_STATUS_CONNECTOR_OFFLINE`)
        );
      })
    ) {
      throw new Error(`Offline upstream status sync was not held for manual action: ${JSON.stringify(synced)}`);
    }

    if (upstream.statusRequests.length > 0) {
      throw new Error(`Offline upstream status sync should not call upstream status: ${JSON.stringify(upstream.statusRequests)}`);
    }

    return {
      taskId: created.id,
      finalStatus: synced.status,
      targets: synced.results.map((target) => ({
        platform: target.platform,
        status: target.status,
        remoteId: target.remoteId,
        url: target.url,
        issueCodes: target.issues.map((issue) => issue.code),
      })),
      upstreamDraftRequests: upstream.requests.map((request) => request.platform).sort(),
      upstreamStatusRequests: upstream.statusRequests.length,
    };
  } finally {
    await Promise.all([stopService(api), stopService(worker), stopService(draftConnector)]);
    if (!upstreamClosed) {
      await upstream.close();
    }
    apiBaseUrl = previousApiBaseUrl;
  }
}

async function runCredentialForwardingCheck() {
  if (process.env.E2E_API_BASE_URL) {
    return { skipped: true };
  }

  const previousApiBaseUrl = apiBaseUrl;
  const upstreamPort = await getFreePort();
  const connectorPort = await getFreePort();
  const apiPort = await getFreePort();
  const upstream = await startFakeUpstreamDraftService(upstreamPort, "credential-upstream-secret");
  const connectorBaseUrl = `http://127.0.0.1:${connectorPort}`;
  const outboxDir = path.join(runtimeDir, `draft-connector-credential-e2e-${Date.now()}`);
  const queueName = `mp-publishing-draft-credential-e2e-${Date.now()}`;
  const platforms = ["zhihu", "bilibili", "xiaohongshu"];
  const expectedCredentials = {
    zhihu: { accountId: "acct_zhihu_main", authMode: "official-api", credentialRef: "env:ZHIHU", hasAccessToken: true },
    bilibili: { accountId: "acct_bilibili_main", authMode: "hybrid", credentialRef: "env:BILIBILI", hasCookies: true },
    xiaohongshu: {
      accountId: "acct_xhs_main",
      authMode: "hybrid",
      credentialRef: "env:XIAOHONGSHU",
      hasStorageStateJson: true,
    },
  };

  fs.rmSync(outboxDir, { recursive: true, force: true });
  apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const connectorEnv = {
    PORT: String(apiPort),
    PUBLISH_QUEUE_NAME: queueName,
    DRAFT_CONNECTOR_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    ZHIHU_REAL_PUBLISH_ENABLED: "true",
    BILIBILI_REAL_PUBLISH_ENABLED: "true",
    XIAOHONGSHU_REAL_PUBLISH_ENABLED: "true",
    ZHIHU_DRAFT_INCLUDE_CREDENTIAL: "true",
    BILIBILI_DRAFT_INCLUDE_CREDENTIAL: "true",
    XIAOHONGSHU_DRAFT_INCLUDE_CREDENTIAL: "true",
    ZHIHU_STATUS_INCLUDE_CREDENTIAL: "true",
    BILIBILI_STATUS_INCLUDE_CREDENTIAL: "true",
    XIAOHONGSHU_STATUS_INCLUDE_CREDENTIAL: "true",
    ZHIHU_ACCESS_TOKEN: "zhihu-e2e-token",
    BILIBILI_COOKIES: "SESSDATA=bilibili-e2e-cookie",
    XIAOHONGSHU_STORAGE_STATE_JSON: "{\"cookies\":[{\"name\":\"xhs\",\"value\":\"e2e\"}]}",
  };
  const draftConnectorEnv = {
    PORT: String(connectorPort),
    DRAFT_CONNECTOR_API_KEY: "draft-secret",
    DRAFT_CONNECTOR_OUTBOX_DIR: outboxDir,
    DRAFT_CONNECTOR_PUBLIC_BASE_URL: connectorBaseUrl,
    DRAFT_CONNECTOR_UPSTREAM_API_KEY: "credential-upstream-secret",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/zhihu/drafts`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/zhihu/status`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_ZHIHU_UPSTREAM_STATUS_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/bilibili/drafts`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/bilibili/status`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_BILIBILI_UPSTREAM_STATUS_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_DRAFT_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/drafts`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_STATUS_ENDPOINT: `${upstream.baseUrl}/xiaohongshu/status`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_HEALTH_ENDPOINT: `${upstream.baseUrl}/health`,
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_INCLUDE_CREDENTIAL: "true",
    DRAFT_CONNECTOR_XIAOHONGSHU_UPSTREAM_STATUS_INCLUDE_CREDENTIAL: "true",
  };

  const api = startService("api-draft-credential", ["apps/api/dist/main.js"], connectorEnv);
  const worker = startService("worker-draft-credential", ["apps/worker/dist/main.js"], connectorEnv);
  const draftConnector = startService("draft-connector-credential", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

  function assertCredential(platform, credential, context) {
    const expected = expectedCredentials[platform];
    if (
      !credential ||
      credential.platform !== platform ||
      credential.accountId !== expected.accountId ||
      credential.authMode !== expected.authMode ||
      credential.credentialRef !== expected.credentialRef ||
      Boolean(credential.hasAccessToken) !== Boolean(expected.hasAccessToken) ||
      Boolean(credential.hasCookies) !== Boolean(expected.hasCookies) ||
      Boolean(credential.hasStorageStateJson) !== Boolean(expected.hasStorageStateJson)
    ) {
      throw new Error(`Credential forwarding mismatch for ${platform} ${context}: ${JSON.stringify(credential)}`);
    }
  }

  try {
    await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector credential forwarding");
    await waitForApi(api);
    await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

    const accountsResponse = await requestJson("/accounts");
    const accounts = accountsResponse.items.filter((account) => platforms.includes(account.platform));
    if (accounts.length !== platforms.length || accounts.some((account) => account.credentialStatus !== "configured")) {
      throw new Error(`Credential forwarding accounts were not configured: ${JSON.stringify(accountsResponse.items)}`);
    }

    const created = await requestJson("/publish/real", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: {
          title: "三平台凭证转发草稿验证",
          summary: "验证显式开启后，平台凭证可以穿过 connector 到达上游草稿服务。",
          body: "这条内容用于确认官方 API 代理或自动化服务需要凭证时，草稿链路可以转发凭证，同时本地 outbox 不持久化凭证。",
          tags: ["draft", "credential", "e2e"],
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
      throw new Error(`Credential forwarding task did not succeed: ${task.status} ${JSON.stringify(task.results)}`);
    }

    if (upstream.requests.length !== platforms.length) {
      throw new Error(`Credential forwarding upstream did not receive every draft: ${JSON.stringify(upstream.requests)}`);
    }

    for (const request of upstream.requests) {
      assertCredential(request.platform, request.credential, "draft request");
      const detail = await requestAbsoluteJson(request.connectorDraftUrl);
      if (detail.payload?.credential) {
        throw new Error(`Credential was persisted in outbox payload for ${request.platform}: ${JSON.stringify(detail)}`);
      }
    }

    const syncedTask = await requestJson(`/publish/tasks/${created.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (syncedTask.status !== "succeeded") {
      throw new Error(`Credential forwarding sync did not preserve succeeded status: ${JSON.stringify(syncedTask)}`);
    }

    if (upstream.statusRequests.length !== platforms.length) {
      throw new Error(`Credential forwarding upstream did not receive every status query: ${JSON.stringify(upstream.statusRequests)}`);
    }

    for (const statusRequest of upstream.statusRequests) {
      assertCredential(statusRequest.platform, statusRequest.credential, "status request");
      const detail = await requestAbsoluteJson(statusRequest.connectorDraftUrl);
      if (detail.payload?.credential) {
        throw new Error(`Credential was persisted after status sync for ${statusRequest.platform}: ${JSON.stringify(detail)}`);
      }
    }

    return {
      taskId: created.id,
      finalStatus: syncedTask.status,
      draftCredentialPlatforms: upstream.requests.map((request) => request.platform).sort(),
      statusCredentialPlatforms: upstream.statusRequests.map((request) => request.platform).sort(),
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
const platforms = ["zhihu", "bilibili", "xiaohongshu"];
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
const workspaceEnvCheck = await runDraftConnectorWorkspaceEnvCheck();
const publicBaseRuntime = await runDraftConnectorPublicBaseRuntimeCheck();
const upstreamContractCheck = await runUpstreamContractCheckScriptCheck();
const upstreamProxyEnablement = await runUpstreamProxyEnablementCheck();
const localEnablement = await runLocalDraftEnablementCheck();
const disabledPreflight = await runDisabledDraftPreflightCheck();
const workerConfigManualAction = await runWorkerDraftConfigManualActionCheck();
const credentialPreflight = await runCredentialPreflightCheck();
const credentialMismatchPreflight = await runCredentialForwardingMismatchPreflightCheck();
const offlinePreflight = await runOfflineDraftConnectorPreflightCheck();
const explicitLocalEndpointPreflight = await runExplicitLocalDraftEndpointPreflightCheck();
const explicitLocalEndpointStatusSync = await runExplicitLocalDraftEndpointStatusSyncCheck();
const offlineUpstreamPreflight = await runOfflineUpstreamDraftPreflightCheck();
const offlineUpstreamRecovery = await runOfflineUpstreamDraftRecoveryCheck();
const upstreamForwarding = await runUpstreamDraftForwardingCheck();
const upstreamRejectionManualAction = await runUpstreamDraftRejectionManualActionCheck();
const statusCredentialMismatch = await runStatusCredentialForwardingMismatchSyncCheck();
const offlineUpstreamStatusSync = await runOfflineUpstreamStatusSyncPreflightCheck();
const credentialForwarding = await runCredentialForwardingCheck();

const api = startService("api", ["apps/api/dist/main.js"], connectorEnv);
const worker = startService("worker", ["apps/worker/dist/main.js"], connectorEnv);
const draftConnector = startService("draft-connector", ["apps/draft-connector/dist/main.js"], draftConnectorEnv);

try {
  const initialHealth = await waitForHealth(draftConnector, `${connectorBaseUrl}/health`, "Draft connector");
  if (
    initialHealth.outbox?.total !== 0 ||
    platforms.some((platform) => initialHealth.outbox?.platforms?.find((item) => item.platform === platform)?.total !== 0)
  ) {
    throw new Error(`Draft connector health should expose an empty outbox summary before publishing: ${JSON.stringify(initialHealth.outbox)}`);
  }

  await waitForApi(api);
  const initialRuntime = await requestJson("/runtime/status");
  if (
    initialRuntime.draftConnector?.status !== "online" ||
    initialRuntime.draftConnector?.outboxUrl !== `${connectorBaseUrl}/drafts` ||
    initialRuntime.draftConnector?.contractUrl !== `${connectorBaseUrl}/contract` ||
    initialRuntime.draftConnector?.outbox?.total !== 0 ||
    platforms.some(
      (platform) =>
        initialRuntime.draftConnector?.platforms?.find((item) => item.platform === platform)?.outboxUrl !==
        `${connectorBaseUrl}/${platform}/drafts`,
    )
  ) {
    throw new Error(`API runtime did not report the draft connector as online: ${JSON.stringify(initialRuntime.draftConnector)}`);
  }

  const connectorContract = await requestAbsoluteJson(initialRuntime.draftConnector.contractUrl);
  if (
    connectorContract.version !== "draft-connector-upstream-v1" ||
    connectorContract.connector?.outboxUrl !== `${connectorBaseUrl}/drafts` ||
    platforms.some((platform) => !connectorContract.supportedPlatforms?.includes(platform)) ||
    !connectorContract.upstream?.draftEndpoint ||
    !connectorContract.upstream?.statusEndpoint ||
    !connectorContract.upstream?.statusCallback
  ) {
    throw new Error(`Draft connector upstream contract is incomplete: ${JSON.stringify(connectorContract)}`);
  }

  await requestJson("/accounts/acct_bilibili_main/refresh", { method: "POST" });

  const accountsResponse = await requestJson("/accounts");
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

  if (
    runtime.draftConnector?.outbox?.total !== platforms.length ||
    platforms.some((platform) => {
      const summary = runtime.draftConnector?.platforms?.find((item) => item.platform === platform)?.outbox;
      return summary?.total !== 1 || summary?.byState?.draft !== 1;
    })
  ) {
    throw new Error(`API runtime did not expose draft outbox summaries after publishing: ${JSON.stringify(runtime.draftConnector)}`);
  }

  const draftDetails = [];
  const idempotentDrafts = [];
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

    if (
      detail.payload?.execution?.taskId !== created.id ||
      !detail.payload.execution.targetId ||
      detail.payload.execution.attemptCount !== target.attemptCount
    ) {
      throw new Error(`Draft connector detail did not persist publish target execution context for ${platform}: ${JSON.stringify(detail.payload?.execution)}`);
    }

    const expectedDraftId = expectedExecutionDraftId(platform, detail.payload.execution);
    if (detail.draftId !== expectedDraftId || target.remoteId !== expectedDraftId) {
      throw new Error(`Draft connector did not use the deterministic execution draft id for ${platform}: ${JSON.stringify({ expectedDraftId, detail, target })}`);
    }

    const countBeforeDuplicate = readDraftOutbox(outboxDir, [platform]).length;
    const duplicate = await requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer draft-secret",
      },
      body: JSON.stringify(detail.payload),
    });
    const countAfterDuplicate = readDraftOutbox(outboxDir, [platform]).length;
    if (duplicate.draftId !== target.remoteId || duplicate.url !== target.url || countAfterDuplicate !== countBeforeDuplicate) {
      throw new Error(
        `Draft connector idempotency did not reuse the existing draft for ${platform}: ${JSON.stringify({
          duplicate,
          countBeforeDuplicate,
          countAfterDuplicate,
          target,
        })}`,
      );
    }

    const concurrentPayload = {
      ...detail.payload,
      execution: {
        ...detail.payload.execution,
        targetId: `${detail.payload.execution.targetId}-concurrent-${platform}`,
        attemptCount: 1,
      },
    };
    const expectedConcurrentDraftId = expectedExecutionDraftId(platform, concurrentPayload.execution);
    const countBeforeConcurrent = readDraftOutbox(outboxDir, [platform]).length;
    const [concurrentLeft, concurrentRight] = await Promise.all([
      requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer draft-secret",
        },
        body: JSON.stringify(concurrentPayload),
      }),
      requestAbsoluteJson(`${connectorBaseUrl}/${platform}/drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer draft-secret",
        },
        body: JSON.stringify(concurrentPayload),
      }),
    ]);
    const countAfterConcurrent = readDraftOutbox(outboxDir, [platform]).length;
    if (
      concurrentLeft.draftId !== expectedConcurrentDraftId ||
      concurrentRight.draftId !== expectedConcurrentDraftId ||
      countAfterConcurrent !== countBeforeConcurrent + 1
    ) {
      throw new Error(
        `Draft connector concurrent idempotency did not reserve one deterministic draft for ${platform}: ${JSON.stringify({
          expectedConcurrentDraftId,
          concurrentLeft,
          concurrentRight,
          countBeforeConcurrent,
          countAfterConcurrent,
        })}`,
      );
    }

    idempotentDrafts.push({
      platform,
      draftId: duplicate.draftId,
      countAfterDuplicate,
      concurrentDraftId: concurrentLeft.draftId,
      countAfterConcurrent,
    });

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
  const finalRuntime = await requestJson("/runtime/status");
  if (outboxIndex.items?.length !== platforms.length * 2) {
    throw new Error(`Draft connector outbox index did not include every stored draft: ${JSON.stringify(outboxIndex)}`);
  }

  if (
    finalRuntime.draftConnector?.outbox?.total !== platforms.length * 2 ||
    platforms.some((platform) => {
      const summary = finalRuntime.draftConnector?.platforms?.find((item) => item.platform === platform)?.outbox;
      return (
        summary?.total !== 2 ||
        summary?.byState?.ready !== 1 ||
        summary?.byState?.draft !== 1 ||
        summary?.externalizedCount !== 1
      );
    })
  ) {
    throw new Error(`API runtime did not expose final draft outbox summaries: ${JSON.stringify(finalRuntime.draftConnector)}`);
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
    const localDraft = draftDetails.find((item) => item.platform === platform);
    const concurrentDraft = idempotentDrafts.find((item) => item.platform === platform);
    const readyDraft = platformOutbox.items?.find((item) => item.draftId === localDraft?.draftId);
    const freshConcurrentDraft = platformOutbox.items?.find((item) => item.draftId === concurrentDraft?.concurrentDraftId);
    if (
      platformOutbox.items?.length !== 2 ||
      readyDraft?.platform !== platform ||
      readyDraft?.state !== "ready" ||
      !readyDraft.externalUrl ||
      freshConcurrentDraft?.platform !== platform ||
      freshConcurrentDraft?.state !== "draft"
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
    idempotentDrafts,
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
      contractUrl: initialRuntime.draftConnector.contractUrl,
      contractVersion: connectorContract.version,
      outbox: finalRuntime.draftConnector.outbox,
    },
    workspaceEnvCheck,
    publicBaseRuntime,
    upstreamContractCheck,
    upstreamProxyEnablement,
    localEnablement,
    disabledPreflight,
    workerConfigManualAction,
    credentialPreflight,
    credentialMismatchPreflight,
    offlinePreflight,
    explicitLocalEndpointPreflight,
    explicitLocalEndpointStatusSync,
    offlineUpstreamPreflight,
    offlineUpstreamRecovery,
    upstreamForwarding,
    upstreamRejectionManualAction,
    statusCredentialMismatch,
    offlineUpstreamStatusSync,
    credentialForwarding,
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
