#!/usr/bin/env node

import { createServer } from "node:http";
import fs from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);
const contractVersion = "draft-connector-upstream-v1";

const usageText = `Usage:
  pnpm drafts:upstream-sandbox -- --port 3020 --api-key sandbox-secret

Options:
  --host <host>                    Defaults to 127.0.0.1.
  --port <port>                    Defaults to DRAFT_UPSTREAM_SANDBOX_PORT or 3020.
  --outbox-dir <path>              Defaults to .runtime/draft-upstream-sandbox.
  --api-key <key>                  Optional bearer token for health, draft, and status requests.
  --initial-state <state>          Defaults to ready.
  --callback                       POST accepted draft status to connector.statusCallbackUrl.
  --callback-delay-ms <ms>         Delay callback delivery; defaults to 0.
  --connector-api-key <key>        Bearer token for connector status callbacks.
  --async-response                 Return publishing without remoteId/url and rely on callback/status sync.
  --help`;

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex > -1) {
      parsed[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function readOption(args, name, envNames = []) {
  if (args[name] !== undefined) {
    return args[name] === true ? "" : String(args[name]);
  }

  for (const envName of envNames) {
    if (process.env[envName]) {
      return process.env[envName];
    }
  }

  return undefined;
}

function readBoolean(args, name, envNames = []) {
  if (args[name] === true) {
    return true;
  }

  if (args[name] !== undefined) {
    return ["1", "true", "yes", "on"].includes(String(args[name]).toLowerCase());
  }

  for (const envName of envNames) {
    if (process.env[envName] !== undefined) {
      return ["1", "true", "yes", "on"].includes(String(process.env[envName]).toLowerCase());
    }
  }

  return false;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be a valid TCP port.");
  }

  return port;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

function normalizeState(value) {
  const state = String(value ?? "").trim();
  if (["draft", "publishing", "ready", "succeeded", "failed", "needs_manual_action"].includes(state)) {
    return state;
  }

  throw new Error("--initial-state must be one of draft, publishing, ready, succeeded, failed, needs_manual_action.");
}

function resolveWorkspacePath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function requireAuthorized(request, response, apiKey) {
  if (!apiKey || request.headers.authorization === `Bearer ${apiKey}`) {
    return true;
  }

  sendJson(response, 401, { ok: false, message: "Upstream sandbox API key is invalid." });
  return false;
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

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

function createExternalUrl(platform, remoteId) {
  return `https://sandbox.example.test/${platform}/${remoteId}`;
}

function draftFilePath(outboxDir, platform, remoteId) {
  return path.join(outboxDir, platform, `${sanitizeSegment(remoteId)}.json`);
}

async function writeRecord(outboxDir, record) {
  const platformDir = path.join(outboxDir, record.platform);
  await mkdir(platformDir, { recursive: true });
  await writeFile(draftFilePath(outboxDir, record.platform, record.remoteId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function readRecord(outboxDir, platform, remoteId) {
  try {
    return JSON.parse(await readFile(draftFilePath(outboxDir, platform, remoteId), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function listRecords(outboxDir, platforms) {
  const records = [];

  for (const platform of platforms) {
    const platformDir = path.join(outboxDir, platform);
    if (!fs.existsSync(platformDir)) {
      continue;
    }

    const fileNames = await readdir(platformDir);
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }

      records.push(JSON.parse(await readFile(path.join(platformDir, fileName), "utf8")));
    }
  }

  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

async function summarizeOutbox(outboxDir) {
  const records = await listRecords(outboxDir, Array.from(supportedPlatforms));
  return {
    total: records.length,
    platforms: Array.from(supportedPlatforms).map((platform) => ({
      platform,
      total: records.filter((record) => record.platform === platform).length,
    })),
  };
}

async function postStatusCallback(record, connectorApiKey) {
  const response = await fetch(record.statusCallbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(connectorApiKey ? { authorization: `Bearer ${connectorApiKey}` } : {}),
    },
    body: JSON.stringify({
      state: record.state,
      remoteId: record.remoteId,
      url: record.url,
      detail: `${record.platform} sandbox upstream draft callback accepted.`,
    }),
  });
  const body = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    body: body.slice(0, 500),
  };
}

function scheduleStatusCallback(outboxDir, record, connectorApiKey, callbackDelayMs) {
  setTimeout(() => {
    void (async () => {
      const latestRecord = (await readRecord(outboxDir, record.platform, record.remoteId)) ?? record;
      const callback = await postStatusCallback(latestRecord, connectorApiKey);
      await writeRecord(outboxDir, {
        ...latestRecord,
        callback,
        callbackAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    })().catch(async (error) => {
      const latestRecord = (await readRecord(outboxDir, record.platform, record.remoteId)) ?? record;
      await writeRecord(outboxDir, {
        ...latestRecord,
        callback: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        callbackAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }, callbackDelayMs);
}

async function handleCreateDraft({
  request,
  response,
  platform,
  outboxDir,
  initialState,
  callbackEnabled,
  callbackDelayMs,
  connectorApiKey,
  asyncResponse,
}) {
  const payload = await readRequestJson(request);
  const connectorDraftId = payload.connector?.draftId;
  const statusCallbackUrl = payload.connector?.statusCallbackUrl;
  const title = payload.draft?.title;
  if (!connectorDraftId || !statusCallbackUrl || !title) {
    sendJson(response, 422, { ok: false, message: "Sandbox draft payload is missing connector metadata or draft.title." });
    return;
  }

  const remoteId = `${platform}-sandbox-${sanitizeSegment(connectorDraftId)}`;
  const now = new Date().toISOString();
  const existing = await readRecord(outboxDir, platform, remoteId);
  const record = {
    ...(existing ?? {}),
    version: "draft-upstream-sandbox-v1",
    platform,
    accountId: payload.accountId,
    connectorDraftId,
    connectorDraftUrl: payload.connector?.draftUrl,
    statusCallbackUrl,
    remoteId,
    url: createExternalUrl(platform, remoteId),
    state: existing?.state ?? initialState,
    title,
    summary: payload.draft?.summary,
    hasCredential: Boolean(payload.credential),
    credential: summarizeCredential(payload.credential),
    receivedAt: existing?.receivedAt ?? now,
    updatedAt: now,
  };

  await writeRecord(outboxDir, record);

  if (callbackEnabled) {
    scheduleStatusCallback(outboxDir, record, connectorApiKey, callbackDelayMs);
  }

  if (asyncResponse) {
    sendJson(response, 200, {
      ok: true,
      state: "publishing",
      detail: `${platform} sandbox upstream draft accepted asynchronously.`,
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    state: record.state,
    remoteId: record.remoteId,
    url: record.url,
    detail: `${platform} sandbox upstream draft accepted.`,
  });
}

async function handleStatus({ request, response, platform, outboxDir }) {
  const payload = await readRequestJson(request);
  const remoteId = payload.remoteId;
  if (!remoteId) {
    sendJson(response, 422, { ok: false, state: "needs_manual_action", detail: "Sandbox status payload must include remoteId." });
    return;
  }

  const record = await readRecord(outboxDir, platform, remoteId);
  if (!record) {
    sendJson(response, 404, {
      ok: false,
      state: "needs_manual_action",
      remoteId,
      detail: `${platform} sandbox upstream draft ${remoteId} was not found.`,
    });
    return;
  }

  const updatedRecord = {
    ...record,
    statusQueriedAt: new Date().toISOString(),
    statusHasCredential: Boolean(payload.credential),
    statusCredential: summarizeCredential(payload.credential),
    updatedAt: new Date().toISOString(),
  };
  await writeRecord(outboxDir, updatedRecord);

  sendJson(response, 200, {
    ok: true,
    state: updatedRecord.state,
    remoteId: updatedRecord.remoteId,
    url: updatedRecord.url,
    detail: `${platform} sandbox upstream draft status returned.`,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const host = readOption(args, "host", ["DRAFT_UPSTREAM_SANDBOX_HOST"]) ?? "127.0.0.1";
  const port = parsePort(readOption(args, "port", ["DRAFT_UPSTREAM_SANDBOX_PORT"]) ?? "3020");
  const outboxDir = resolveWorkspacePath(readOption(args, "outbox-dir", ["DRAFT_UPSTREAM_SANDBOX_OUTBOX_DIR"]) ?? ".runtime/draft-upstream-sandbox");
  const apiKey = readOption(args, "api-key", ["DRAFT_UPSTREAM_SANDBOX_API_KEY"]);
  const connectorApiKey = readOption(args, "connector-api-key", ["DRAFT_CONNECTOR_API_KEY"]);
  const initialState = normalizeState(readOption(args, "initial-state", ["DRAFT_UPSTREAM_SANDBOX_INITIAL_STATE"]) ?? "ready");
  const callbackEnabled = readBoolean(args, "callback", ["DRAFT_UPSTREAM_SANDBOX_CALLBACK"]);
  const callbackDelayMs = parseNonNegativeInteger(readOption(args, "callback-delay-ms", ["DRAFT_UPSTREAM_SANDBOX_CALLBACK_DELAY_MS"]) ?? "0", "--callback-delay-ms");
  const asyncResponse = readBoolean(args, "async-response", ["DRAFT_UPSTREAM_SANDBOX_ASYNC_RESPONSE"]);

  await mkdir(outboxDir, { recursive: true });

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (!requireAuthorized(request, response, apiKey)) {
          return;
        }

        const url = new URL(request.url ?? "/", `http://${host}:${port}`);
        const parts = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && url.pathname === "/health") {
          sendJson(response, 200, {
            ok: true,
            status: "ok",
            version: "draft-upstream-sandbox-v1",
            contractVersion,
            outboxDir,
            platforms: Array.from(supportedPlatforms),
            outbox: await summarizeOutbox(outboxDir),
          });
          return;
        }

        if (request.method === "GET" && url.pathname === "/drafts") {
          sendJson(response, 200, { ok: true, outboxDir, items: await listRecords(outboxDir, Array.from(supportedPlatforms)) });
          return;
        }

        const [platform, operation] = parts;
        if (!supportedPlatforms.has(platform)) {
          sendJson(response, 404, { ok: false, message: "Unsupported upstream sandbox platform." });
          return;
        }

        if (request.method === "GET" && operation === "drafts") {
          sendJson(response, 200, { ok: true, outboxDir, items: await listRecords(outboxDir, [platform]) });
          return;
        }

        if (request.method === "POST" && operation === "drafts") {
          await handleCreateDraft({
            request,
            response,
            platform,
            outboxDir,
            initialState,
            callbackEnabled,
            callbackDelayMs,
            connectorApiKey,
            asyncResponse,
          });
          return;
        }

        if (request.method === "POST" && operation === "status") {
          await handleStatus({ request, response, platform, outboxDir });
          return;
        }

        sendJson(response, 404, { ok: false, message: "Upstream sandbox route not found." });
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          message: error instanceof Error ? error.message : "Unknown upstream sandbox error.",
        });
      }
    })();
  });

  server.listen(port, host, () => {
    console.log(`draft upstream sandbox listening on http://${host}:${port}`);
    console.log(`draft upstream sandbox outbox: ${outboxDir}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
