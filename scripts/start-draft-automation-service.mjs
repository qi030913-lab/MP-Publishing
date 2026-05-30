#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);
const supportedStates = new Set(["draft", "publishing", "ready", "succeeded", "failed", "needs_manual_action"]);

const usageText = `Usage:
  pnpm drafts:automation-service -- --port 3030 --api-key automation-secret

Options:
  --host <host>                    Defaults to 127.0.0.1.
  --port <port>                    Defaults to DRAFT_AUTOMATION_SERVICE_PORT or 3030.
  --outbox-dir <path>              Defaults to .runtime/draft-automation-service.
  --public-base-url <url>          Defaults to http://<host>:<port>.
  --api-key <key>                  Optional bearer token for health, contract, draft, and list routes.
  --handler-module <path>          Optional ESM module exporting createDraft(input) for real platform automation.
  --external-url-template <value>  Optional fallback URL template with {platform}, {remoteId}, {workOrderId}.
  --help

Routes:
  GET /health
  GET /contract
  GET /drafts
  GET /:platform/drafts
  GET /:platform/drafts/:automationDraftId
  POST /drafts                     Accept a draft-upstream-work-order-v1 runner payload.

Without --handler-module, POST /drafts stores a local automation handoff record and returns
that inspection URL as the draft URL. A handler module can call Playwright or an official API
and return the real platform draft id/url while keeping the runner contract unchanged.`;

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

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be a valid TCP port.");
  }

  return port;
}

function normalizeHttpBaseUrl(value, label) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }

  return url.toString().replace(/\/+$/, "");
}

function normalizeState(value, fallback = "ready") {
  const state = String(value ?? fallback).trim();
  if (supportedStates.has(state)) {
    return state;
  }

  throw new Error(`Unsupported draft state "${state}".`);
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function hasBearerToken(request, apiKey) {
  return Boolean(apiKey && request.headers.authorization === `Bearer ${apiKey}`);
}

function isAuthorized(request, apiKey) {
  return !apiKey || hasBearerToken(request, apiKey);
}

function recordPath(outboxDir, platform, automationDraftId) {
  return path.join(outboxDir, platform, `${automationDraftId}.json`);
}

async function writeRecord(outboxDir, record) {
  const platformDir = path.join(outboxDir, record.platform);
  await mkdir(platformDir, { recursive: true });
  await writeFile(recordPath(outboxDir, record.platform, record.automationDraftId), JSON.stringify(record, null, 2), "utf8");
}

async function readRecord(outboxDir, platform, automationDraftId) {
  try {
    const raw = await readFile(recordPath(outboxDir, platform, automationDraftId), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function listRecords(outboxDir, platform) {
  const platforms = platform ? [platform] : Array.from(supportedPlatforms);
  const records = [];

  for (const currentPlatform of platforms) {
    try {
      const entries = await readdir(path.join(outboxDir, currentPlatform), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const raw = await readFile(path.join(outboxDir, currentPlatform, entry.name), "utf8");
        records.push(JSON.parse(raw));
      }
    } catch {
      // Missing platform directories simply mean no records yet.
    }
  }

  return records.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

function summarizeRecord(record) {
  return {
    platform: record.platform,
    automationDraftId: record.automationDraftId,
    workOrderId: record.workOrderId,
    accountId: record.accountId,
    state: record.state,
    title: record.title,
    remoteId: record.remoteId,
    url: record.url,
    mode: record.mode,
    updatedAt: record.updatedAt,
    detailUrl: record.detailUrl,
  };
}

function readUrlTemplate(platform, args) {
  return (
    readOption(args, `${platform}-external-url-template`, [`DRAFT_AUTOMATION_${platform.toUpperCase()}_EXTERNAL_URL_TEMPLATE`]) ??
    readOption(args, "external-url-template", ["DRAFT_AUTOMATION_EXTERNAL_URL_TEMPLATE"])
  );
}

function renderTemplate(template, values) {
  return template.replace(/\{(platform|remoteId|workOrderId)\}/g, (_match, key) => values[key] ?? "");
}

function createDefaultAutomationResult({ workOrder, automationDraftId, publicBaseUrl, urlTemplate }) {
  const remoteId = automationDraftId;
  const templateValues = {
    platform: workOrder.platform,
    remoteId,
    workOrderId: workOrder.remoteId,
  };

  return {
    ok: true,
    remoteId,
    url: urlTemplate
      ? renderTemplate(urlTemplate, templateValues)
      : `${publicBaseUrl}/${workOrder.platform}/drafts/${automationDraftId}`,
    state: "ready",
    detail: `${workOrder.platform} work order staged by local draft automation service.`,
  };
}

function validateAutomationPayload(payload) {
  const workOrder = payload.workOrder;
  const platform = asString(payload.platform) ?? asString(workOrder?.platform);
  if (!platform || !supportedPlatforms.has(platform)) {
    throw new Error("Automation payload must include a supported platform.");
  }

  const checklist = Array.isArray(workOrder?.checklist) ? workOrder.checklist : [];
  if (
    payload.platform !== platform ||
    workOrder?.platform !== platform ||
    workOrder?.version !== "draft-upstream-work-order-v1" ||
    !asString(workOrder?.remoteId) ||
    !asString(workOrder?.draft?.title) ||
    !asString(workOrder?.draft?.renderedBody) ||
    !workOrder?.connector?.statusCallbackUrl ||
    workOrder?.automation?.safeMode !== true ||
    !checklist.some((item) => item.id === "save-draft" && item.required)
  ) {
    throw new Error("Automation payload is missing draft-upstream-work-order-v1 data.");
  }

  return { platform, workOrder };
}

function normalizeAutomationResult(result, fallback) {
  const payload = result && typeof result === "object" ? result : {};
  if (payload.ok === false) {
    return {
      ok: false,
      state: normalizeState(payload.state, "needs_manual_action"),
      detail: asString(payload.detail) ?? asString(payload.message) ?? "Automation handler rejected the work order.",
      issues: Array.isArray(payload.issues) ? payload.issues : [],
    };
  }

  return {
    ok: true,
    remoteId: asString(payload.remoteId) ?? asString(payload.externalDraftId) ?? asString(payload.draftId) ?? fallback.remoteId,
    url: asString(payload.url) ?? asString(payload.externalUrl) ?? fallback.url,
    state: normalizeState(payload.state, fallback.state),
    detail: asString(payload.detail) ?? asString(payload.message) ?? fallback.detail,
    issues: Array.isArray(payload.issues) ? payload.issues : [],
  };
}

async function loadHandler(handlerModulePath) {
  if (!handlerModulePath) {
    return undefined;
  }

  const moduleUrl = pathToFileURL(path.resolve(handlerModulePath)).href;
  const loaded = await import(moduleUrl);
  const handler = loaded.createDraft ?? loaded.default?.createDraft ?? loaded.default;
  if (typeof handler !== "function") {
    throw new Error("--handler-module must export a createDraft function or default function.");
  }

  return handler;
}

function createContract({ publicBaseUrl, hasHandler }) {
  return {
    version: "draft-automation-service-v1",
    purpose: "Receives draft-upstream-work-order-v1 payloads and turns them into platform draft ids/URLs.",
    supportedPlatforms: Array.from(supportedPlatforms),
    routes: {
      health: "GET /health",
      contract: "GET /contract",
      createDraft: "POST /drafts",
      listDrafts: "GET /drafts or GET /:platform/drafts",
      readDraft: "GET /:platform/drafts/:automationDraftId",
    },
    request: {
      platform: "zhihu | bilibili | xiaohongshu",
      accountId: "Platform account id from the work order.",
      workOrder: "draft-upstream-work-order-v1",
      runner: {
        completedBy: "Runner identity.",
        safeMode: true,
      },
    },
    response: {
      ok: "false asks the runner to fail the work order instead of completing it.",
      remoteId: "Real platform draft id, or local automation handoff id when no handler is configured.",
      url: "Real platform draft URL, or local automation handoff URL when no handler is configured.",
      state: Array.from(supportedStates),
      detail: "Human-readable automation result.",
      issues: "Optional ValidationIssue[] with code, message, severity.",
    },
    handler: hasHandler
      ? "custom"
      : "none; default mode stages local handoff records. Set --handler-module to run Playwright or official API automation.",
    exampleLocalUrl: `${publicBaseUrl}/zhihu/drafts/<automationDraftId>`,
  };
}

async function handleCreateDraft({ request, response, outboxDir, publicBaseUrl, apiKey, handler, handlerModulePath, urlTemplates }) {
  if (!isAuthorized(request, apiKey)) {
    sendJson(response, 401, { ok: false, message: "automation api key is invalid" });
    return;
  }

  const payload = await readRequestJson(request);
  let platform;
  let workOrder;
  try {
    ({ platform, workOrder } = validateAutomationPayload(payload));
  } catch (error) {
    sendJson(response, 422, { ok: false, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  const now = new Date().toISOString();
  const automationDraftId = `${platform}-automation-${sanitizeSegment(workOrder.remoteId || Date.now())}`;
  const detailUrl = `${publicBaseUrl}/${platform}/drafts/${automationDraftId}`;
  const fallback = createDefaultAutomationResult({
    workOrder,
    automationDraftId,
    publicBaseUrl,
    urlTemplate: urlTemplates.get(platform),
  });

  let result;
  try {
    const handlerResult = handler
      ? await handler({
          platform,
          accountId: payload.accountId,
          workOrder,
          requestedAt: payload.requestedAt ?? now,
          runner: payload.runner ?? {},
          context: {
            outboxDir,
            publicBaseUrl,
            detailUrl,
            fallback,
          },
        })
      : fallback;
    result = normalizeAutomationResult(handlerResult, fallback);
  } catch (error) {
    sendJson(response, 502, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const record = {
    platform,
    automationDraftId,
    workOrderId: workOrder.remoteId,
    accountId: payload.accountId ?? workOrder.accountId,
    title: workOrder.draft.title,
    state: result.state,
    remoteId: result.remoteId ?? automationDraftId,
    url: result.url ?? detailUrl,
    mode: handler ? "handler" : "local-handoff",
    handlerModule: handler ? handlerModulePath : undefined,
    detail: result.detail,
    issues: result.issues ?? [],
    detailUrl,
    workOrder,
    runner: payload.runner ?? {},
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(outboxDir, record);

  sendJson(response, result.ok ? 200 : 202, {
    ok: result.ok,
    remoteId: record.remoteId,
    url: record.url,
    state: record.state,
    detail: record.detail,
    ...(record.issues.length > 0 ? { issues: record.issues } : {}),
    automationDraft: summarizeRecord(record),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const host = readOption(args, "host", ["DRAFT_AUTOMATION_SERVICE_HOST"]) ?? "127.0.0.1";
  const port = parsePort(readOption(args, "port", ["DRAFT_AUTOMATION_SERVICE_PORT"]) ?? "3030");
  const publicBaseUrl = normalizeHttpBaseUrl(
    readOption(args, "public-base-url", ["DRAFT_AUTOMATION_SERVICE_PUBLIC_BASE_URL"]) ?? `http://${host}:${port}`,
    "--public-base-url",
  );
  const apiKey = readOption(args, "api-key", ["DRAFT_AUTOMATION_SERVICE_API_KEY"]);
  const outboxDir = path.resolve(root, readOption(args, "outbox-dir", ["DRAFT_AUTOMATION_SERVICE_OUTBOX_DIR"]) ?? ".runtime/draft-automation-service");
  const handlerModulePath = readOption(args, "handler-module", ["DRAFT_AUTOMATION_SERVICE_HANDLER_MODULE"]);
  const handler = await loadHandler(handlerModulePath);
  const urlTemplates = new Map(
    Array.from(supportedPlatforms)
      .map((platform) => [platform, readUrlTemplate(platform, args)])
      .filter(([, template]) => Boolean(template)),
  );

  await mkdir(outboxDir, { recursive: true });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", publicBaseUrl);
      const [platform, operation, automationDraftId] = url.pathname.split("/").filter(Boolean);

      if (!isAuthorized(request, apiKey)) {
        sendJson(response, 401, { ok: false, message: "automation api key is invalid" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          status: "ok",
          supportedPlatforms: Array.from(supportedPlatforms),
          handlerConfigured: Boolean(handler),
          outboxDir,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/contract") {
        sendJson(response, 200, createContract({ publicBaseUrl, hasHandler: Boolean(handler) }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/drafts") {
        const records = await listRecords(outboxDir);
        sendJson(response, 200, { ok: true, total: records.length, items: records.map(summarizeRecord) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/drafts") {
        await handleCreateDraft({ request, response, outboxDir, publicBaseUrl, apiKey, handler, handlerModulePath, urlTemplates });
        return;
      }

      if (!supportedPlatforms.has(platform) || operation !== "drafts") {
        sendJson(response, 404, { ok: false, message: "automation route not found" });
        return;
      }

      if (request.method === "GET" && !automationDraftId) {
        const records = await listRecords(outboxDir, platform);
        sendJson(response, 200, { ok: true, total: records.length, items: records.map(summarizeRecord) });
        return;
      }

      if (request.method === "GET" && automationDraftId) {
        const record = await readRecord(outboxDir, platform, automationDraftId);
        if (!record) {
          sendJson(response, 404, { ok: false, message: "automation draft not found" });
          return;
        }
        sendJson(response, 200, { ok: true, ...record });
        return;
      }

      sendJson(response, 404, { ok: false, message: "automation route not found" });
    })().catch((error) => {
      sendJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(port, host, () => {
    console.log(
      JSON.stringify({
        ok: true,
        status: "listening",
        baseUrl: publicBaseUrl,
        outboxDir,
        handlerConfigured: Boolean(handler),
      }),
    );
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
