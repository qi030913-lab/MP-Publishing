#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadWorkspaceEnv } from "./lib/workspace-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadWorkspaceEnv({ root });
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
  --require-session                Require a platform session before accepting work orders.
  --<platform>-require-session     Require a session only for one platform.
  --help

Routes:
  GET /health
  GET /contract
  GET /drafts
  GET /:platform/drafts
  GET /:platform/drafts/:automationDraftId
  POST /drafts                     Accept a draft-upstream-work-order-v1 runner payload.
  POST /:platform/drafts           Accept the draft-connector-upstream-v1 draft endpoint payload directly.

Without --handler-module, POST /drafts and POST /:platform/drafts store a local automation
handoff record and return that inspection URL as the draft URL. A handler module can call
Playwright or an official API and return the real platform draft id/url while keeping both
the runner and draft-connector upstream contracts unchanged.

Session env:
  DRAFT_AUTOMATION_<PLATFORM>_ACCESS_TOKEN
  DRAFT_AUTOMATION_<PLATFORM>_COOKIES
  DRAFT_AUTOMATION_<PLATFORM>_STORAGE_STATE_JSON
  DRAFT_AUTOMATION_<PLATFORM>_STORAGE_STATE_PATH
  DRAFT_AUTOMATION_<PLATFORM>_APP_ID
  DRAFT_AUTOMATION_<PLATFORM>_APP_SECRET
  DRAFT_AUTOMATION_<PLATFORM>_CREATOR_BASE_URL
  DRAFT_AUTOMATION_<PLATFORM>_CREATOR_DRAFT_URL`;

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

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function definedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function resolveOptionalPath(value) {
  if (!value) {
    return undefined;
  }

  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function readPlatformSession(platform, args) {
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const required =
    readBoolean(args, `${platform}-require-session`, [`${envPrefix}_REQUIRE_SESSION`]) ||
    readBoolean(args, "require-session", ["DRAFT_AUTOMATION_REQUIRE_SESSION"]);
  const session = {
    platform,
    required,
    accountLabel: readOption(args, `${platform}-account-label`, [`${envPrefix}_ACCOUNT_LABEL`]),
    authMode: readOption(args, `${platform}-auth-mode`, [`${envPrefix}_AUTH_MODE`]),
    credentialRef: readOption(args, `${platform}-credential-ref`, [`${envPrefix}_CREDENTIAL_REF`]),
    creatorBaseUrl: readOption(args, `${platform}-creator-base-url`, [`${envPrefix}_CREATOR_BASE_URL`]),
    creatorDraftUrl: readOption(args, `${platform}-creator-draft-url`, [`${envPrefix}_CREATOR_DRAFT_URL`]),
    appId: readOption(args, `${platform}-app-id`, [`${envPrefix}_APP_ID`]),
    appSecret: readOption(args, `${platform}-app-secret`, [`${envPrefix}_APP_SECRET`]),
    accessToken: readOption(args, `${platform}-access-token`, [`${envPrefix}_ACCESS_TOKEN`]),
    refreshToken: readOption(args, `${platform}-refresh-token`, [`${envPrefix}_REFRESH_TOKEN`]),
    cookies: readOption(args, `${platform}-cookies`, [`${envPrefix}_COOKIES`]),
    storageStateJson: readOption(args, `${platform}-storage-state-json`, [`${envPrefix}_STORAGE_STATE_JSON`]),
    storageStatePath: resolveOptionalPath(
      readOption(args, `${platform}-storage-state-path`, [`${envPrefix}_STORAGE_STATE_PATH`, `${envPrefix}_STORAGE_STATE_FILE`]),
    ),
    expiresAt: readOption(args, `${platform}-expires-at`, [`${envPrefix}_EXPIRES_AT`]),
    credentialSource: "configured-env",
  };

  const ready = hasSessionMaterial(session);
  return {
    ...session,
    credentialSource: ready ? session.credentialSource : undefined,
    ready,
  };
}

function hasSessionMaterial(session) {
  return Boolean(
    session?.accessToken ||
      session?.cookies ||
      session?.storageStateJson ||
      session?.storageStatePath ||
      session?.refreshToken ||
      (session?.appId && session?.appSecret),
  );
}

function credentialSessionFromForwardedCredential(platform, credential) {
  if (!isPlainObject(credential)) {
    return undefined;
  }

  const credentialPlatform = definedString(credential.platform);
  if (credentialPlatform && credentialPlatform !== platform) {
    throw new Error(`Forwarded credential platform ${credentialPlatform} does not match ${platform}.`);
  }

  const session = {
    platform,
    accountId: definedString(credential.accountId),
    accountLabel: definedString(credential.credentialRef) ?? definedString(credential.accountId),
    authMode: definedString(credential.authMode),
    credentialRef: definedString(credential.credentialRef),
    appId: definedString(credential.appId),
    appSecret: definedString(credential.appSecret),
    accessToken: definedString(credential.accessToken),
    refreshToken: definedString(credential.refreshToken),
    cookies: definedString(credential.cookies),
    storageStateJson: definedString(credential.storageStateJson),
    storageStatePath: resolveOptionalPath(definedString(credential.storageStatePath)),
    expiresAt: definedString(credential.expiresAt),
    credentialSource: "connector-forwarded",
  };

  return hasSessionMaterial(session) ? session : undefined;
}

function createHandlerPlatformSession(platformSession, forwardedCredential) {
  const forwardedSession = credentialSessionFromForwardedCredential(platformSession.platform, forwardedCredential);
  if (!forwardedSession) {
    return platformSession;
  }

  const merged = {
    ...platformSession,
    ...Object.fromEntries(Object.entries(forwardedSession).filter(([, value]) => value !== undefined)),
    required: platformSession.required,
    creatorBaseUrl: platformSession.creatorBaseUrl,
    creatorDraftUrl: platformSession.creatorDraftUrl,
  };

  return {
    ...merged,
    ready: hasSessionMaterial(merged),
  };
}

function summarizePlatformSession(session) {
  const authModes = [
    session.appId && session.appSecret ? "app-secret" : undefined,
    session.accessToken ? "access-token" : undefined,
    session.refreshToken ? "refresh-token" : undefined,
    session.cookies ? "cookies" : undefined,
    session.storageStateJson ? "storage-state-json" : undefined,
    session.storageStatePath ? "storage-state-path" : undefined,
  ].filter(Boolean);

  return {
    platform: session.platform,
    required: session.required,
    ready: session.ready,
    accountLabel: session.accountLabel,
    authMode: session.authMode,
    credentialRef: session.credentialRef,
    credentialSource: session.credentialSource,
    creatorBaseUrl: session.creatorBaseUrl,
    creatorDraftUrl: session.creatorDraftUrl,
    authModes,
    hasAppCredentials: Boolean(session.appId && session.appSecret),
    hasAccessToken: Boolean(session.accessToken),
    hasRefreshToken: Boolean(session.refreshToken),
    hasCookies: Boolean(session.cookies),
    hasStorageStateJson: Boolean(session.storageStateJson),
    hasStorageStatePath: Boolean(session.storageStatePath),
  };
}

function summarizePlatformSessions(platformSessions) {
  return Array.from(platformSessions.values()).map(summarizePlatformSession);
}

function getMissingRequiredSessions(platformSessions) {
  return Array.from(platformSessions.values()).filter((session) => session.required && !session.ready);
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

function readStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readValidationIssues(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object" && typeof item.code === "string" && typeof item.message === "string")
    .map((item) => ({
      code: item.code,
      message: item.message,
      severity: ["info", "warning", "error"].includes(item.severity) ? item.severity : "warning",
    }));
}

function summarizeForwardedCredential(credential) {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  return {
    platform: credential.platform,
    accountId: credential.accountId,
    authMode: credential.authMode,
    credentialRef: credential.credentialRef,
    hasAccessToken: Boolean(credential.accessToken),
    hasCookies: Boolean(credential.cookies),
    hasStorageStateJson: Boolean(credential.storageStateJson),
    hasStorageStatePath: Boolean(credential.storageStatePath),
  };
}

function createRenderedBody(draft) {
  const segments = [asString(draft.summary), asString(draft.body)].filter(Boolean);
  const hashtags = readStringArray(draft.hashtags);
  return [...segments, hashtags.length > 0 ? hashtags.join(" ") : undefined].filter(Boolean).join("\n\n");
}

function createConnectorWorkOrderChecklist(platform, draft) {
  const checklist = [
    {
      id: "open-creator-center",
      label: `Open the ${platform} creator center with the intended account selected.`,
      required: true,
    },
    {
      id: "fill-title",
      label: "Fill the platform draft title.",
      required: true,
      sourceField: "draft.title",
    },
    {
      id: "fill-body",
      label: "Fill the main draft body without clicking final publish.",
      required: true,
      sourceField: "draft.body",
    },
    {
      id: "apply-tags",
      label: "Apply hashtags or topic tags when the platform compose form supports them.",
      required: false,
      sourceField: "draft.hashtags",
    },
    {
      id: "save-draft",
      label: "Save as draft and capture the real platform draft id or URL.",
      required: true,
    },
  ];

  if (readValidationIssues(draft.warnings).length > 0) {
    checklist.splice(4, 0, {
      id: "review-validation-warnings",
      label: "Review platform validation warnings before saving the draft.",
      required: true,
      sourceField: "draft.warnings",
    });
  }

  return checklist;
}

function createWorkOrderFromConnectorDraft(platform, payload, now) {
  const draft = payload.draft ?? {};
  const payloadPlatform = asString(payload.platform) ?? asString(draft.platform);
  const connectorDraftId = asString(payload.connector?.draftId);
  const statusCallbackUrl = asString(payload.connector?.statusCallbackUrl);
  const title = asString(draft.title);
  const body = asString(draft.body);

  if ((payloadPlatform && payloadPlatform !== platform) || !connectorDraftId || !statusCallbackUrl || !title || !body) {
    throw new Error(
      "Connector draft payload must include matching platform, connector.draftId, connector.statusCallbackUrl, draft.title, and draft.body.",
    );
  }

  const warnings = readValidationIssues(draft.warnings);
  const hashtags = readStringArray(draft.hashtags);

  return {
    version: "draft-upstream-work-order-v1",
    platform,
    remoteId: connectorDraftId,
    url: asString(payload.connector?.draftUrl),
    accountId: asString(payload.accountId),
    createdAt: now,
    connector: {
      draftId: connectorDraftId,
      draftUrl: asString(payload.connector?.draftUrl),
      statusCallbackUrl,
      callbackAuthEnv: "DRAFT_CONNECTOR_STATUS_CALLBACK_API_KEY",
    },
    document: {
      id: asString(payload.document?.id),
      title: asString(payload.document?.title),
    },
    draft: {
      title,
      summary: asString(draft.summary),
      body,
      hashtags,
      warnings,
      renderedBody: createRenderedBody(draft),
    },
    credential: {
      required: Boolean(payload.credential),
      summary: summarizeForwardedCredential(payload.credential),
    },
    automation: {
      mode: "creator-center-draft-fill",
      safeMode: true,
      finalPublishMustRemainManual: true,
      expectedResult: "A platform draft id or draft URL, not a published public URL.",
    },
    callbackPayloadTemplate: {
      state: "ready",
      remoteId: "<real-platform-draft-id>",
      url: "<real-platform-draft-url>",
      detail: `${platform} creator-center draft was saved by upstream automation.`,
    },
    checklist: createConnectorWorkOrderChecklist(platform, draft),
  };
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

function createContract({ publicBaseUrl, hasHandler, platformSessions }) {
  return {
    version: "draft-automation-service-v1",
    purpose:
      "Receives draft-upstream-work-order-v1 runner payloads or draft-connector-upstream-v1 draft requests and turns them into platform draft ids/URLs.",
    supportedPlatforms: Array.from(supportedPlatforms),
    routes: {
      health: "GET /health",
      contract: "GET /contract",
      createDraft: "POST /drafts",
      createDraftFromConnector: "POST /:platform/drafts",
      listDrafts: "GET /drafts or GET /:platform/drafts",
      readDraft: "GET /:platform/drafts/:automationDraftId",
    },
    request: {
      platform: "zhihu | bilibili | xiaohongshu",
      accountId: "Platform account id from the work order.",
      workOrder: "draft-upstream-work-order-v1",
      connectorUpstreamPayload:
        "draft-connector-upstream-v1 draft endpoint payload accepted at POST /:platform/drafts and converted into a safe work order.",
      runner: {
        completedBy: "Runner identity.",
        safeMode: true,
      },
      handlerInput: {
        platformSession:
          "Sensitive platform session material for the selected platform. Includes configured env session data plus per-request connector-forwarded credentials when present, and is never persisted by the service.",
        sessionSummary: "Redacted session readiness summary safe for logs and health checks.",
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
    platformSessions: summarizePlatformSessions(platformSessions),
    exampleLocalUrl: `${publicBaseUrl}/zhihu/drafts/<automationDraftId>`,
  };
}

async function createAutomationDraft({
  platform,
  accountId,
  workOrder,
  forwardedCredential,
  requestedAt,
  runner,
  outboxDir,
  publicBaseUrl,
  handler,
  handlerModulePath,
  urlTemplates,
  platformSessions,
}) {
  const platformSession = platformSessions.get(platform) ?? { platform, required: false, ready: false };
  let handlerPlatformSession;
  try {
    handlerPlatformSession = createHandlerPlatformSession(platformSession, forwardedCredential);
  } catch (error) {
    return {
      statusCode: 422,
      body: {
        ok: false,
        state: "needs_manual_action",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const sessionSummary = summarizePlatformSession(handlerPlatformSession);
  if (handlerPlatformSession.required && !handlerPlatformSession.ready) {
    return {
      statusCode: 428,
      body: {
        ok: false,
        state: "needs_manual_action",
        message: `${platform} automation session is required but not configured.`,
        sessionSummary,
      },
    };
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
          accountId,
          workOrder,
          requestedAt: requestedAt ?? now,
          runner: runner ?? {},
          platformSession: handlerPlatformSession,
          sessionSummary,
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
    return {
      statusCode: 502,
      body: {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const record = {
    platform,
    automationDraftId,
    workOrderId: workOrder.remoteId,
    accountId: accountId ?? workOrder.accountId,
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
    runner: runner ?? {},
    createdAt: now,
    updatedAt: now,
  };
  await writeRecord(outboxDir, record);

  return {
    statusCode: result.ok ? 200 : 202,
    body: {
      ok: result.ok,
      remoteId: record.remoteId,
      url: record.url,
      state: record.state,
      detail: record.detail,
      ...(record.issues.length > 0 ? { issues: record.issues } : {}),
      automationDraft: summarizeRecord(record),
    },
  };
}

async function handleCreateDraft({
  request,
  response,
  outboxDir,
  publicBaseUrl,
  apiKey,
  handler,
  handlerModulePath,
  urlTemplates,
  platformSessions,
}) {
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

  const result = await createAutomationDraft({
    platform,
    accountId: payload.accountId,
    workOrder,
    requestedAt: payload.requestedAt,
    runner: payload.runner,
    outboxDir,
    publicBaseUrl,
    handler,
    handlerModulePath,
    urlTemplates,
    platformSessions,
  });
  sendJson(response, result.statusCode, result.body);
}

async function handleCreateConnectorDraft({
  request,
  response,
  platform,
  outboxDir,
  publicBaseUrl,
  apiKey,
  handler,
  handlerModulePath,
  urlTemplates,
  platformSessions,
}) {
  if (!isAuthorized(request, apiKey)) {
    sendJson(response, 401, { ok: false, message: "automation api key is invalid" });
    return;
  }

  const payload = await readRequestJson(request);
  const now = new Date().toISOString();
  let workOrder;
  try {
    workOrder = createWorkOrderFromConnectorDraft(platform, payload, now);
  } catch (error) {
    sendJson(response, 422, { ok: false, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  const result = await createAutomationDraft({
    platform,
    accountId: asString(payload.accountId) ?? workOrder.accountId,
    workOrder,
    forwardedCredential: payload.credential,
    requestedAt: payload.requestedAt ?? now,
    runner: {
      completedBy: "draft-connector-upstream",
      safeMode: true,
      source: "draft-connector-upstream-v1",
    },
    outboxDir,
    publicBaseUrl,
    handler,
    handlerModulePath,
    urlTemplates,
    platformSessions,
  });
  sendJson(response, result.statusCode, result.body);
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
  const platformSessions = new Map(Array.from(supportedPlatforms).map((platform) => [platform, readPlatformSession(platform, args)]));
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
        const missingSessions = getMissingRequiredSessions(platformSessions);
        sendJson(response, 200, {
          ok: true,
          status: missingSessions.length > 0 ? "needs_session" : "ok",
          supportedPlatforms: Array.from(supportedPlatforms),
          handlerConfigured: Boolean(handler),
          platformSessions: summarizePlatformSessions(platformSessions),
          missingRequiredSessions: missingSessions.map((session) => session.platform),
          outboxDir,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/contract") {
        sendJson(response, 200, createContract({ publicBaseUrl, hasHandler: Boolean(handler), platformSessions }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/drafts") {
        const records = await listRecords(outboxDir);
        sendJson(response, 200, { ok: true, total: records.length, items: records.map(summarizeRecord) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/drafts") {
        await handleCreateDraft({
          request,
          response,
          outboxDir,
          publicBaseUrl,
          apiKey,
          handler,
          handlerModulePath,
          urlTemplates,
          platformSessions,
        });
        return;
      }

      if (!supportedPlatforms.has(platform) || operation !== "drafts") {
        sendJson(response, 404, { ok: false, message: "automation route not found" });
        return;
      }

      if (request.method === "POST" && !automationDraftId) {
        await handleCreateConnectorDraft({
          request,
          response,
          platform,
          outboxDir,
          publicBaseUrl,
          apiKey,
          handler,
          handlerModulePath,
          urlTemplates,
          platformSessions,
        });
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
        platformSessions: summarizePlatformSessions(platformSessions),
      }),
    );
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
