import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type DraftPayload = {
  platform?: string;
  accountId?: string;
  execution?: {
    taskId?: string;
    targetId?: string;
    attemptCount?: number;
  };
  document?: {
    id?: string;
    title?: string;
  };
  draft?: {
    platform?: string;
    title?: string;
    summary?: string;
    body?: string;
    hashtags?: string[];
    warnings?: ValidationIssue[];
  };
  credential?: unknown;
  requestedAt?: string;
};

type DraftState =
  | "draft"
  | "adapting"
  | "ready"
  | "publishing"
  | "partially_succeeded"
  | "succeeded"
  | "failed"
  | "needs_manual_action";

type ValidationIssue = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

type StoredDraft = {
  draftId: string;
  platform: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  state: DraftState;
  externalDraftId?: string;
  externalDraftIdAliases?: string[];
  externalUrl?: string;
  statusDetail?: string;
  statusIssues?: ValidationIssue[];
  payload: DraftPayload;
};

type DraftSummary = {
  draftId: string;
  platform: string;
  accountId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: DraftState;
  externalDraftId?: string;
  externalDraftIdAliases?: string[];
  externalUrl?: string;
  statusDetail?: string;
  url: string;
};

type DraftOutboxPlatformSummary = {
  platform: string;
  total: number;
  externalizedCount: number;
  stalePublishingCount: number;
  latestUpdatedAt?: string;
  byState: Record<DraftState, number>;
};

type UpstreamDraftConfig = {
  endpoint: string;
  statusEndpoint?: string;
  healthEndpoint?: string;
  apiKey?: string;
  statusApiKey?: string;
  includeCredential: boolean;
  statusIncludeCredential: boolean;
};

type UpstreamDraftStatus = {
  platform: string;
  draftEndpointConfigured: boolean;
  statusEndpointConfigured: boolean;
  credentialForwardingEnabled: boolean;
  statusCredentialForwardingEnabled: boolean;
  healthEndpoint?: string;
  status: "unconfigured" | "configured" | "online" | "offline" | "needs_action";
  detail?: string;
};

type UpstreamHealthPayload = {
  ok?: boolean;
  status?: string;
  message?: string;
  detail?: string;
  missingRequiredSessions?: string[];
};

type UpstreamDraftResponse = {
  ok?: boolean;
  draftId?: string;
  remoteId?: string;
  externalDraftId?: string;
  url?: string;
  externalUrl?: string;
  state?: string;
  detail?: string;
  message?: string;
  issues?: unknown[];
};

const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);
const supportedDraftStates = new Set<DraftState>([
  "draft",
  "adapting",
  "ready",
  "publishing",
  "partially_succeeded",
  "succeeded",
  "failed",
  "needs_manual_action",
]);

function findWorkspaceRoot(startDir: string) {
  let currentDir = startDir;

  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return startDir;
    }

    currentDir = parentDir;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());

function loadWorkspaceEnv() {
  const envPath = path.join(workspaceRoot, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    process.env[key] ??= value;
  }
}

loadWorkspaceEnv();

const port = Number(process.env.PORT ?? 3010);
function resolveWorkspacePath(value: string) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
}

const outboxDir = process.env.DRAFT_CONNECTOR_OUTBOX_DIR
  ? resolveWorkspacePath(process.env.DRAFT_CONNECTOR_OUTBOX_DIR)
  : path.join(workspaceRoot, ".runtime", "drafts");

function normalizeDraftIdSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function createDraftId(platform: string, execution?: DraftPayload["execution"]) {
  const normalizedExecution = normalizeExecutionContext(execution);
  const targetSegment = normalizedExecution ? normalizeDraftIdSegment(normalizedExecution.targetId) : "";
  if (targetSegment) {
    return `${platform}-draft-${targetSegment}-attempt-${normalizedExecution!.attemptCount}`;
  }

  return `${platform}-draft-${randomUUID()}`;
}

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isEnvEnabled(key: string) {
  return readEnvValue(key)?.toLowerCase() === "true";
}

function readPositiveIntegerEnv(key: string, fallback: number) {
  const value = Number(readEnvValue(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createIssue(code: string, message: string, severity: ValidationIssue["severity"] = "error"): ValidationIssue {
  return { code, message, severity };
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, statusCode: number, html: string) {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function resolvePublicBaseUrl(request: IncomingMessage) {
  const configuredBaseUrl = process.env.DRAFT_CONNECTOR_PUBLIC_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"])?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.host || `localhost:${port}`;
  const protocol = forwardedProto || "http";
  return `${protocol}://${host}`;
}

function createDraftUrl(platform: string, draftId: string, request: IncomingMessage) {
  return `${resolvePublicBaseUrl(request)}/${platform}/drafts/${draftId}`;
}

function createStatusCallbackUrl(platform: string, draftId: string, request: IncomingMessage) {
  return `${createDraftUrl(platform, draftId, request)}/status`;
}

function createUpstreamContract(request: IncomingMessage) {
  const baseUrl = resolvePublicBaseUrl(request);
  const platforms = Array.from(supportedPlatforms);
  const draftStates = Array.from(supportedDraftStates);

  return {
    ok: true,
    version: "draft-connector-upstream-v1",
    generatedAt: new Date().toISOString(),
    connector: {
      healthUrl: `${baseUrl}/health`,
      contractUrl: `${baseUrl}/contract`,
      outboxUrl: `${baseUrl}/drafts`,
      routes: {
        createLocalDraft: "POST /:platform/drafts",
        queryLocalDraftStatus: "POST /:platform/status",
        updateLocalDraftStatus: "POST /:platform/drafts/:draftId/status",
        listLocalDrafts: "GET /drafts?format=json or GET /:platform/drafts?format=json",
      },
    },
    supportedPlatforms: platforms,
    draftStates,
    upstream: {
      draftEndpoint: {
        configuredBy:
          "DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_DRAFT_ENDPOINT, with optional DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_DRAFT_API_KEY",
        method: "POST",
        auth: "Authorization: Bearer <api key>, when an upstream API key is configured",
        request: {
          platform: "zhihu | bilibili | xiaohongshu",
          accountId: "Runtime account id selected for this target",
          document: "Canonical document snapshot used to build the platform draft",
          draft: {
            platform: "Target platform",
            title: "Platform-specific draft title",
            summary: "Optional platform-specific summary",
            body: "Platform-specific draft body",
            hashtags: ["Optional platform tags"],
            warnings: "Adapter validation warnings",
          },
          execution: {
            taskId: "Publish task id",
            targetId: "Publish target id",
            attemptCount: "Worker attempt number",
          },
          credential:
            "Optional credential object. Present only when both adapter and connector credential-forwarding flags are enabled.",
          requestedAt: "ISO timestamp",
          connector: {
            draftId: "Deterministic local connector draft id",
            draftUrl: `${baseUrl}/:platform/drafts/:draftId`,
            statusCallbackUrl: `${baseUrl}/:platform/drafts/:draftId/status`,
          },
        },
        response: {
          ok: "false marks the connector draft as needs_manual_action; omitted or true accepts the draft",
          remoteId: "Real platform draft id, or equivalent upstream draft id",
          externalDraftId: "Alias for remoteId",
          url: "Real platform draft URL",
          externalUrl: "Alias for url",
          state: draftStates,
          detail: "Human-readable status detail",
          message: "Alias for detail",
          issues: "Optional ValidationIssue[] with code, message, severity",
        },
      },
      statusEndpoint: {
        configuredBy:
          "DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_STATUS_ENDPOINT or DRAFT_CONNECTOR_UPSTREAM_STATUS_ENDPOINT",
        method: "POST",
        auth: "Authorization: Bearer <api key>, when an upstream status API key is configured",
        request: {
          platform: "zhihu | bilibili | xiaohongshu",
          accountId: "Runtime account id when available",
          remoteId: "External draft id when linked, otherwise the connector draft id",
          credential:
            "Optional credential object. Present only when both adapter and connector status credential-forwarding flags are enabled.",
          requestedAt: "ISO timestamp",
          connector: {
            draftId: "Local connector draft id",
            draftUrl: `${baseUrl}/:platform/drafts/:draftId`,
            statusCallbackUrl: `${baseUrl}/:platform/drafts/:draftId/status`,
          },
        },
        response: {
          ok: "false keeps or moves the local draft to needs_manual_action",
          remoteId: "Real platform draft id",
          externalDraftId: "Alias for remoteId",
          url: "Real platform draft URL",
          externalUrl: "Alias for url",
          state: draftStates,
          detail: "Human-readable status detail",
          message: "Alias for detail",
          issues: "Optional ValidationIssue[] with code, message, severity",
        },
      },
      statusCallback: {
        endpoint: `${baseUrl}/:platform/drafts/:draftId/status`,
        method: "POST",
        auth:
          "Authorization: Bearer <callback or connector api key>. Uses DRAFT_CONNECTOR_STATUS_CALLBACK_API_KEY for upstream callbacks when configured; DRAFT_CONNECTOR_API_KEY remains accepted and is the fallback when no callback key is configured.",
        relatedEnv: ["DRAFT_CONNECTOR_STATUS_CALLBACK_API_KEY", "DRAFT_CONNECTOR_API_KEY"],
        purpose:
          "External upstream workers can call this route after async creator-center automation creates or updates the real platform draft.",
        request: {
          state: draftStates,
          remoteId: "Real platform draft id",
          externalDraftId: "Alias for remoteId",
          url: "Real platform draft URL",
          externalUrl: "Alias for url",
          detail: "Human-readable status detail",
          issues: "Optional ValidationIssue[] with code, message, severity",
        },
      },
    },
    credentialForwarding: {
      draft:
        "Enable both <PLATFORM>_DRAFT_INCLUDE_CREDENTIAL=true and DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_INCLUDE_CREDENTIAL=true.",
      status:
        "Enable both <PLATFORM>_STATUS_INCLUDE_CREDENTIAL=true and DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_STATUS_INCLUDE_CREDENTIAL=true.",
      persistence: "Credentials are forwarded for the request only and are not stored in the local outbox.",
    },
  };
}

function readSecretEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function hasBearerToken(request: IncomingMessage, apiKey: string | undefined) {
  return Boolean(apiKey && request.headers.authorization === `Bearer ${apiKey}`);
}

function requireAuthorized(request: IncomingMessage) {
  const apiKey = readSecretEnv("DRAFT_CONNECTOR_API_KEY");
  if (!apiKey) {
    return true;
  }

  return hasBearerToken(request, apiKey);
}

function requireStatusCallbackAuthorized(request: IncomingMessage) {
  const callbackApiKey = readSecretEnv("DRAFT_CONNECTOR_STATUS_CALLBACK_API_KEY");
  if (!callbackApiKey) {
    return requireAuthorized(request);
  }

  return hasBearerToken(request, callbackApiKey) || hasBearerToken(request, readSecretEnv("DRAFT_CONNECTOR_API_KEY"));
}

function parseRoute(url: string | undefined) {
  const parsed = new URL(url ?? "/", "http://localhost");
  const [platform, operation, draftId, action] = parsed.pathname.split("/").filter(Boolean);
  return { platform, operation, draftId, action };
}

function validatePlatform(platform: string | undefined) {
  return platform && supportedPlatforms.has(platform) ? platform : null;
}

function validateDraftId(draftId: string | undefined) {
  return draftId && /^[a-z0-9-]+$/i.test(draftId) ? draftId : null;
}

function validateRemoteId(remoteId: string | undefined) {
  return remoteId && remoteId.length <= 200 && /^[a-z0-9_.:-]+$/i.test(remoteId) ? remoteId : null;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeDraftState(value: unknown): DraftState | null {
  return typeof value === "string" && supportedDraftStates.has(value as DraftState) ? (value as DraftState) : null;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  if (!value || typeof value !== "object") {
    return false;
  }

  const issue = value as Partial<ValidationIssue>;
  return (
    typeof issue.code === "string" &&
    typeof issue.message === "string" &&
    (issue.severity === "info" || issue.severity === "warning" || issue.severity === "error")
  );
}

function normalizeIssues(value: unknown) {
  return Array.isArray(value) ? value.filter(isValidationIssue) : undefined;
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : undefined;
}

function createExternalDraftIdAliases(storedDraft: StoredDraft, nextExternalDraftId: string | undefined) {
  const aliases = new Set(normalizeStringList(storedDraft.externalDraftIdAliases) ?? []);
  if (storedDraft.externalDraftId && nextExternalDraftId && storedDraft.externalDraftId !== nextExternalDraftId) {
    aliases.add(storedDraft.externalDraftId);
  }

  if (nextExternalDraftId) {
    aliases.delete(nextExternalDraftId);
  }

  return aliases.size > 0 ? Array.from(aliases) : undefined;
}

function normalizeStoredDraft(raw: StoredDraft): StoredDraft {
  return {
    ...raw,
    state: normalizeDraftState(raw.state) ?? "draft",
    updatedAt: raw.updatedAt ?? raw.createdAt,
    externalDraftIdAliases: normalizeStringList(raw.externalDraftIdAliases),
    statusIssues: normalizeIssues(raw.statusIssues),
  };
}

function normalizeExecutionContext(execution: DraftPayload["execution"]) {
  const taskId = readOptionalString(execution?.taskId);
  const targetId = readOptionalString(execution?.targetId);
  const attemptCount =
    typeof execution?.attemptCount === "number" && Number.isFinite(execution.attemptCount)
      ? execution.attemptCount
      : undefined;

  return targetId && attemptCount ? { taskId, targetId, attemptCount } : null;
}

function validateDraftPayload(platform: string, payload: DraftPayload) {
  const draftPlatform = payload.draft?.platform ?? payload.platform;
  if (draftPlatform && draftPlatform !== platform) {
    return `Payload platform ${draftPlatform} does not match route platform ${platform}.`;
  }

  if (!payload.accountId) {
    return "Draft payload must include accountId.";
  }

  if (!payload.draft?.title) {
    return "Draft payload must include draft.title.";
  }

  if (!payload.draft?.body) {
    return "Draft payload must include draft.body.";
  }

  return null;
}

function sanitizeDraftPayload(payload: DraftPayload): DraftPayload {
  const payloadRecord = { ...(payload as Record<string, unknown>) };
  delete payloadRecord.credential;
  return payloadRecord as DraftPayload;
}

function resolveUpstreamDraftConfig(platform: string): UpstreamDraftConfig | null {
  const envPrefix = `DRAFT_CONNECTOR_${platform.toUpperCase()}_UPSTREAM`;
  const endpoint = readEnvValue(`${envPrefix}_DRAFT_ENDPOINT`);
  if (!endpoint) {
    return null;
  }

  return {
    endpoint,
    statusEndpoint: readEnvValue(`${envPrefix}_STATUS_ENDPOINT`) ?? readEnvValue("DRAFT_CONNECTOR_UPSTREAM_STATUS_ENDPOINT"),
    healthEndpoint: readEnvValue(`${envPrefix}_HEALTH_ENDPOINT`) ?? readEnvValue("DRAFT_CONNECTOR_UPSTREAM_HEALTH_ENDPOINT"),
    apiKey: readEnvValue(`${envPrefix}_DRAFT_API_KEY`) ?? readEnvValue("DRAFT_CONNECTOR_UPSTREAM_API_KEY"),
    statusApiKey:
      readEnvValue(`${envPrefix}_STATUS_API_KEY`) ??
      readEnvValue(`${envPrefix}_DRAFT_API_KEY`) ??
      readEnvValue("DRAFT_CONNECTOR_UPSTREAM_API_KEY"),
    includeCredential: isEnvEnabled(`${envPrefix}_INCLUDE_CREDENTIAL`),
    statusIncludeCredential: isEnvEnabled(`${envPrefix}_STATUS_INCLUDE_CREDENTIAL`),
  };
}

function isReadyHealthStatus(status: string | undefined) {
  if (!status) {
    return true;
  }

  return ["ok", "online", "ready", "healthy"].includes(status.toLowerCase());
}

function summarizeUpstreamHealthPayload(payload: UpstreamHealthPayload | undefined, platform: string) {
  if (!payload) {
    return {
      status: "online" as const,
      detail: "Upstream draft health check returned HTTP 200.",
    };
  }

  const healthStatus = typeof payload.status === "string" ? payload.status : undefined;
  const missingRequiredSessions = Array.isArray(payload.missingRequiredSessions)
    ? payload.missingRequiredSessions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  if (payload.ok === false) {
    return {
      status: "needs_action" as const,
      detail: payload.detail ?? payload.message ?? "Upstream draft health check reported ok=false.",
    };
  }

  if (healthStatus?.toLowerCase() === "needs_session") {
    const missingDetail =
      missingRequiredSessions.length > 0
        ? ` Missing required sessions: ${missingRequiredSessions.join(", ")}.`
        : "";
    return {
      status: missingRequiredSessions.length === 0 || missingRequiredSessions.includes(platform) ? "needs_action" as const : "online" as const,
      detail: `Upstream draft health check reported status "${healthStatus}".${missingDetail}`,
    };
  }

  if (!isReadyHealthStatus(healthStatus)) {
    return {
      status: "needs_action" as const,
      detail: payload.detail ?? payload.message ?? `Upstream draft health check reported status "${healthStatus}".`,
    };
  }

  return {
    status: "online" as const,
    detail: `Upstream draft health check reported status "${healthStatus ?? "ok"}".`,
  };
}

async function probeUpstreamDraftStatus(platform: string): Promise<UpstreamDraftStatus> {
  const config = resolveUpstreamDraftConfig(platform);
  if (!config) {
    return {
      platform,
      draftEndpointConfigured: false,
      statusEndpointConfigured: false,
      credentialForwardingEnabled: false,
      statusCredentialForwardingEnabled: false,
      status: "unconfigured",
    };
  }

  if (!config.healthEndpoint) {
    return {
      platform,
      draftEndpointConfigured: true,
      statusEndpointConfigured: Boolean(config.statusEndpoint),
      credentialForwardingEnabled: config.includeCredential,
      statusCredentialForwardingEnabled: config.statusIncludeCredential,
      status: "configured",
      detail: "Upstream draft endpoint is configured; no health endpoint is configured.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(config.healthEndpoint, {
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined,
      signal: controller.signal,
    });
    const payload = response.ok
      ? ((await response.json().catch(() => undefined)) as UpstreamHealthPayload | undefined)
      : undefined;
    const healthSummary = response.ok ? summarizeUpstreamHealthPayload(payload, platform) : undefined;

    return {
      platform,
      draftEndpointConfigured: true,
      statusEndpointConfigured: Boolean(config.statusEndpoint),
      credentialForwardingEnabled: config.includeCredential,
      statusCredentialForwardingEnabled: config.statusIncludeCredential,
      healthEndpoint: config.healthEndpoint,
      status: response.ok ? healthSummary!.status : "offline",
      detail: response.ok ? healthSummary!.detail : `Upstream draft health check failed with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      platform,
      draftEndpointConfigured: true,
      statusEndpointConfigured: Boolean(config.statusEndpoint),
      credentialForwardingEnabled: config.includeCredential,
      statusCredentialForwardingEnabled: config.statusIncludeCredential,
      healthEndpoint: config.healthEndpoint,
      status: "offline",
      detail: error instanceof Error ? error.message : "Upstream draft health check failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function listUpstreamDraftStatuses() {
  return Promise.all(Array.from(supportedPlatforms).map((platform) => probeUpstreamDraftStatus(platform)));
}

function createUpstreamPayload(
  payload: DraftPayload,
  storedDraft: StoredDraft,
  request: IncomingMessage,
  includeCredential: boolean,
) {
  return {
    ...sanitizeDraftPayload(payload),
    credential: includeCredential ? payload.credential : undefined,
    connector: {
      draftId: storedDraft.draftId,
      draftUrl: createDraftUrl(storedDraft.platform, storedDraft.draftId, request),
      statusCallbackUrl: createStatusCallbackUrl(storedDraft.platform, storedDraft.draftId, request),
    },
  };
}

function createUpstreamStatusPayload(
  payload: Record<string, unknown>,
  storedDraft: StoredDraft,
  request: IncomingMessage,
  includeCredential: boolean,
) {
  return {
    platform: storedDraft.platform,
    accountId: readOptionalString(payload.accountId) ?? storedDraft.accountId,
    remoteId: storedDraft.externalDraftId ?? readOptionalString(payload.remoteId) ?? storedDraft.draftId,
    credential: includeCredential ? payload.credential : undefined,
    requestedAt: new Date().toISOString(),
    connector: {
      draftId: storedDraft.draftId,
      draftUrl: createDraftUrl(storedDraft.platform, storedDraft.draftId, request),
      statusCallbackUrl: createStatusCallbackUrl(storedDraft.platform, storedDraft.draftId, request),
    },
  };
}

async function requestUpstreamDraft(
  config: UpstreamDraftConfig,
  payload: DraftPayload,
  storedDraft: StoredDraft,
  request: IncomingMessage,
) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(createUpstreamPayload(payload, storedDraft, request, config.includeCredential)),
  });
  const body = await response.text();
  const upstreamPayload = body ? (JSON.parse(body) as UpstreamDraftResponse) : {};

  if (!response.ok) {
    throw new Error(`Upstream draft endpoint HTTP ${response.status}: ${body || response.statusText}`);
  }

  return upstreamPayload;
}

async function requestUpstreamDraftStatus(
  config: UpstreamDraftConfig,
  payload: Record<string, unknown>,
  storedDraft: StoredDraft,
  request: IncomingMessage,
) {
  if (!config.statusEndpoint) {
    return null;
  }

  const response = await fetch(config.statusEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.statusApiKey ? { authorization: `Bearer ${config.statusApiKey}` } : {}),
    },
    body: JSON.stringify(createUpstreamStatusPayload(payload, storedDraft, request, config.statusIncludeCredential)),
  });
  const body = await response.text();
  const upstreamPayload = body ? (JSON.parse(body) as UpstreamDraftResponse) : {};

  if (!response.ok) {
    throw new Error(`Upstream status endpoint HTTP ${response.status}: ${body || response.statusText}`);
  }

  return upstreamPayload;
}

function applyUpstreamDraftResponse(storedDraft: StoredDraft, payload: UpstreamDraftResponse): StoredDraft {
  const externalDraftId =
    readOptionalString(payload.externalDraftId) ?? readOptionalString(payload.remoteId) ?? readOptionalString(payload.draftId);
  const externalUrl = readOptionalString(payload.externalUrl) ?? readOptionalString(payload.url);
  const nextState = normalizeDraftState(payload.state) ?? (externalDraftId || externalUrl ? "ready" : storedDraft.state);
  const statusDetail = readOptionalString(payload.detail) ?? readOptionalString(payload.message) ?? storedDraft.statusDetail;
  const statusIssues = normalizeIssues(payload.issues);
  const nextExternalDraftId = externalDraftId ?? storedDraft.externalDraftId;

  return {
    ...storedDraft,
    state: nextState,
    externalDraftId: nextExternalDraftId,
    externalDraftIdAliases: createExternalDraftIdAliases(storedDraft, nextExternalDraftId),
    externalUrl: externalUrl ?? storedDraft.externalUrl,
    statusDetail,
    statusIssues: statusIssues ?? storedDraft.statusIssues,
    updatedAt: new Date().toISOString(),
  };
}

function createForwardingDraft(storedDraft: StoredDraft): StoredDraft {
  return {
    ...storedDraft,
    state: "publishing",
    statusDetail: `${storedDraft.platform} draft is being forwarded to an upstream draft service.`,
    updatedAt: new Date().toISOString(),
  };
}

function hasExternalDraft(storedDraft: StoredDraft) {
  return Boolean(storedDraft.externalDraftId || storedDraft.externalUrl);
}

function isStalePublishingDraft(storedDraft: StoredDraft) {
  const resumeAfterMs = readPositiveIntegerEnv("DRAFT_CONNECTOR_UPSTREAM_RESUME_AFTER_MS", 2 * 60 * 1000);
  const updatedAt = new Date(storedDraft.updatedAt).getTime();
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= resumeAfterMs;
}

function shouldResumeUpstreamForwarding(storedDraft: StoredDraft, upstreamConfig: UpstreamDraftConfig | null) {
  if (!upstreamConfig || hasExternalDraft(storedDraft)) {
    return false;
  }

  if (storedDraft.state === "draft") {
    return true;
  }

  return storedDraft.state === "publishing" && isStalePublishingDraft(storedDraft);
}

async function forwardStoredDraftToUpstream(
  storedDraft: StoredDraft,
  payload: DraftPayload,
  request: IncomingMessage,
  upstreamConfig: UpstreamDraftConfig,
) {
  const draftUrl = createDraftUrl(storedDraft.platform, storedDraft.draftId, request);
  const forwardingDraft = createForwardingDraft(storedDraft);
  await writeStoredDraft(forwardingDraft);

  try {
    const upstreamPayload = await requestUpstreamDraft(upstreamConfig, payload, forwardingDraft, request);
    const upstreamState = normalizeDraftState(upstreamPayload.state);
    const upstreamIssues = normalizeIssues(upstreamPayload.issues);

    if (upstreamPayload.ok === false || upstreamState === "failed" || upstreamState === "needs_manual_action") {
      const rejectedDraft: StoredDraft = {
        ...applyUpstreamDraftResponse(forwardingDraft, upstreamPayload),
        state: upstreamState ?? "needs_manual_action",
        statusIssues: [
          ...(upstreamIssues ?? []),
          createIssue(
            `${storedDraft.platform.toUpperCase()}_UPSTREAM_DRAFT_REJECTED`,
            upstreamPayload.message ??
              upstreamPayload.detail ??
              `${storedDraft.platform} upstream draft service rejected the draft.`,
          ),
        ],
      };
      await writeStoredDraft(rejectedDraft);
      return {
        ok: false,
        draftId: storedDraft.draftId,
        remoteId: rejectedDraft.externalDraftId ?? storedDraft.draftId,
        url: rejectedDraft.externalUrl ?? draftUrl,
        message: rejectedDraft.statusDetail ?? `${storedDraft.platform} upstream draft service rejected the draft.`,
        issues: rejectedDraft.statusIssues,
      };
    }

    const updatedDraft = applyUpstreamDraftResponse(forwardingDraft, upstreamPayload);
    await writeStoredDraft(updatedDraft);
    return {
      ok: true,
      draftId: storedDraft.draftId,
      remoteId: updatedDraft.externalDraftId ?? storedDraft.draftId,
      url: updatedDraft.externalUrl ?? draftUrl,
      message: updatedDraft.statusDetail ?? `${storedDraft.platform} draft forwarded to upstream draft service.`,
      issues: updatedDraft.statusIssues,
    };
  } catch (error) {
    const failedDraft: StoredDraft = {
      ...forwardingDraft,
      state: "needs_manual_action",
      statusDetail: error instanceof Error ? error.message : `${storedDraft.platform} upstream draft service failed.`,
      statusIssues: [
        createIssue(
          `${storedDraft.platform.toUpperCase()}_UPSTREAM_DRAFT_FAILED`,
          error instanceof Error ? error.message : `${storedDraft.platform} upstream draft service failed.`,
        ),
      ],
      updatedAt: new Date().toISOString(),
    };
    await writeStoredDraft(failedDraft);
    return {
      ok: false,
      draftId: storedDraft.draftId,
      remoteId: storedDraft.draftId,
      url: draftUrl,
      message: failedDraft.statusDetail,
      issues: failedDraft.statusIssues,
    };
  }
}

async function refreshStoredDraftFromUpstreamStatus(
  storedDraft: StoredDraft,
  payload: Record<string, unknown>,
  request: IncomingMessage,
) {
  const upstreamConfig = resolveUpstreamDraftConfig(storedDraft.platform);
  if (!upstreamConfig?.statusEndpoint) {
    return storedDraft;
  }

  try {
    const upstreamPayload = await requestUpstreamDraftStatus(upstreamConfig, payload, storedDraft, request);
    if (!upstreamPayload) {
      return storedDraft;
    }

    const upstreamState = normalizeDraftState(upstreamPayload.state);
    const upstreamIssues = normalizeIssues(upstreamPayload.issues);
    const updatedDraft: StoredDraft = {
      ...applyUpstreamDraftResponse(storedDraft, upstreamPayload),
      state: upstreamPayload.ok === false ? upstreamState ?? "needs_manual_action" : upstreamState ?? storedDraft.state,
      statusIssues:
        upstreamPayload.ok === false
          ? [
              ...(upstreamIssues ?? []),
              createIssue(
                `${storedDraft.platform.toUpperCase()}_UPSTREAM_STATUS_REJECTED`,
                upstreamPayload.message ??
                  upstreamPayload.detail ??
                  `${storedDraft.platform} upstream status service rejected the status request.`,
              ),
            ]
          : upstreamIssues ?? storedDraft.statusIssues,
    };

    await writeStoredDraft(updatedDraft);
    return updatedDraft;
  } catch (error) {
    const failedDraft: StoredDraft = {
      ...storedDraft,
      state: "needs_manual_action",
      statusDetail: error instanceof Error ? error.message : `${storedDraft.platform} upstream status service failed.`,
      statusIssues: [
        createIssue(
          `${storedDraft.platform.toUpperCase()}_UPSTREAM_STATUS_FAILED`,
          error instanceof Error ? error.message : `${storedDraft.platform} upstream status service failed.`,
          "warning",
        ),
      ],
      updatedAt: new Date().toISOString(),
    };
    await writeStoredDraft(failedDraft);
    return failedDraft;
  }
}

async function readStoredDraft(platform: string, draftId: string) {
  const filePath = path.join(outboxDir, platform, `${draftId}.json`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return normalizeStoredDraft(JSON.parse(await readFile(filePath, "utf8")) as StoredDraft);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }

      if (!(error instanceof SyntaxError) || attempt === 4) {
        throw error;
      }

      await delay(10 * (attempt + 1));
    }
  }

  return null;
}

async function writeStoredDraft(storedDraft: StoredDraft) {
  const platformOutboxDir = path.join(outboxDir, storedDraft.platform);
  const filePath = path.join(platformOutboxDir, `${storedDraft.draftId}.json`);

  await mkdir(platformOutboxDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(storedDraft, null, 2)}\n`, "utf8");
}

async function writeStoredDraftIfAbsent(storedDraft: StoredDraft) {
  const platformOutboxDir = path.join(outboxDir, storedDraft.platform);
  const filePath = path.join(platformOutboxDir, `${storedDraft.draftId}.json`);

  await mkdir(platformOutboxDir, { recursive: true });

  try {
    await writeFile(filePath, `${JSON.stringify(storedDraft, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

async function findStoredDraftByRemoteId(platform: string, remoteId: string) {
  const localDraftId = validateDraftId(remoteId);
  if (localDraftId) {
    const directMatch = await readStoredDraft(platform, localDraftId);
    if (directMatch) {
      return directMatch;
    }
  }

  const platformOutboxDir = path.join(outboxDir, platform);
  if (!existsSync(platformOutboxDir)) {
    return null;
  }

  const fileNames = await readdir(platformOutboxDir);
  for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
    const storedDraft = await readStoredDraft(platform, fileName.replace(/\.json$/, ""));
    if (!storedDraft) {
      continue;
    }

    if (storedDraft.externalDraftId === remoteId || storedDraft.externalDraftIdAliases?.includes(remoteId)) {
      return storedDraft;
    }
  }

  return null;
}

async function findStoredDraftByExecution(platform: string, execution: DraftPayload["execution"]) {
  const normalizedExecution = normalizeExecutionContext(execution);
  if (!normalizedExecution) {
    return null;
  }

  const platformOutboxDir = path.join(outboxDir, platform);
  if (!existsSync(platformOutboxDir)) {
    return null;
  }

  const fileNames = await readdir(platformOutboxDir);
  for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
    const storedDraft = await readStoredDraft(platform, fileName.replace(/\.json$/, ""));
    if (!storedDraft) {
      continue;
    }

    const storedExecution = normalizeExecutionContext(storedDraft.payload.execution);
    if (
      storedExecution?.targetId === normalizedExecution.targetId &&
      storedExecution.attemptCount === normalizedExecution.attemptCount
    ) {
      return storedDraft;
    }
  }

  return null;
}

function createStoredDraftResponse(storedDraft: StoredDraft, request: IncomingMessage) {
  const draftUrl = createDraftUrl(storedDraft.platform, storedDraft.draftId, request);
  const reusable = storedDraft.state !== "failed" && storedDraft.state !== "needs_manual_action";

  return {
    ok: reusable,
    draftId: storedDraft.draftId,
    remoteId: storedDraft.externalDraftId ?? storedDraft.draftId,
    url: storedDraft.externalUrl ?? draftUrl,
    message:
      storedDraft.statusDetail ??
      (reusable
        ? `${storedDraft.platform} draft already exists for this publish target.`
        : `${storedDraft.platform} draft requires manual action before it can be reused.`),
    issues: storedDraft.statusIssues,
  };
}

function createEmptyDraftStateCounts(): Record<DraftState, number> {
  return Array.from(supportedDraftStates).reduce(
    (counts, state) => ({
      ...counts,
      [state]: 0,
    }),
    {} as Record<DraftState, number>,
  );
}

async function summarizePlatformOutbox(platform: string): Promise<DraftOutboxPlatformSummary> {
  const summary: DraftOutboxPlatformSummary = {
    platform,
    total: 0,
    externalizedCount: 0,
    stalePublishingCount: 0,
    byState: createEmptyDraftStateCounts(),
  };
  const platformOutboxDir = path.join(outboxDir, platform);
  if (!existsSync(platformOutboxDir)) {
    return summary;
  }

  const fileNames = await readdir(platformOutboxDir);
  for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
    const storedDraft = await readStoredDraft(platform, fileName.replace(/\.json$/, ""));
    if (!storedDraft) {
      continue;
    }

    summary.total += 1;
    summary.byState[storedDraft.state] += 1;
    if (hasExternalDraft(storedDraft)) {
      summary.externalizedCount += 1;
    }

    if (storedDraft.state === "publishing" && isStalePublishingDraft(storedDraft)) {
      summary.stalePublishingCount += 1;
    }

    if (
      !summary.latestUpdatedAt ||
      new Date(storedDraft.updatedAt).getTime() > new Date(summary.latestUpdatedAt).getTime()
    ) {
      summary.latestUpdatedAt = storedDraft.updatedAt;
    }
  }

  return summary;
}

async function summarizeOutbox(platforms: string[]) {
  const summaries = await Promise.all(platforms.map((platform) => summarizePlatformOutbox(platform)));
  return {
    total: summaries.reduce((total, summary) => total + summary.total, 0),
    platforms: summaries,
  };
}

function shouldReturnJson(request: IncomingMessage) {
  const parsed = new URL(request.url ?? "/", "http://localhost");
  const accept = firstHeaderValue(request.headers.accept) ?? "";
  return parsed.searchParams.get("format") === "json" || accept.includes("application/json");
}

function renderDraftHtml(storedDraft: StoredDraft, url: string) {
  const title = storedDraft.payload.draft?.title ?? storedDraft.payload.document?.title ?? storedDraft.draftId;
  const body = storedDraft.payload.draft?.body ?? "";
  const hashtags = storedDraft.payload.draft?.hashtags?.join(" ") ?? "";
  const externalLink = storedDraft.externalUrl
    ? `<p><a href="${escapeHtml(storedDraft.externalUrl)}" target="_blank" rel="noreferrer">Open external platform draft</a></p>`
    : "";
  const json = JSON.stringify(storedDraft, null, 2);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f7f7f4; }
      main { width: min(960px, calc(100vw - 32px)); margin: 32px auto; }
      .meta, pre { background: #fff; border: 1px solid #d7d7cf; border-radius: 8px; padding: 16px; }
      .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0; }
      .meta span { display: block; color: #626a73; font-size: 13px; }
      .meta strong { display: block; margin-top: 4px; }
      article { background: #fff; border: 1px solid #d7d7cf; border-radius: 8px; padding: 24px; line-height: 1.75; }
      pre { overflow-x: auto; margin-top: 20px; font-size: 13px; line-height: 1.55; }
      a { color: #225fd7; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <div><span>Platform</span><strong>${escapeHtml(storedDraft.platform)}</strong></div>
        <div><span>Account</span><strong>${escapeHtml(storedDraft.accountId ?? "unknown")}</strong></div>
        <div><span>State</span><strong>${escapeHtml(storedDraft.state)}</strong></div>
        <div><span>Draft ID</span><strong>${escapeHtml(storedDraft.draftId)}</strong></div>
        <div><span>External Draft</span><strong>${escapeHtml(storedDraft.externalDraftId ?? "not linked")}</strong></div>
        <div><span>Created</span><strong>${escapeHtml(storedDraft.createdAt)}</strong></div>
        <div><span>Updated</span><strong>${escapeHtml(storedDraft.updatedAt)}</strong></div>
      </div>
      ${storedDraft.statusDetail ? `<p>${escapeHtml(storedDraft.statusDetail)}</p>` : ""}
      <article>${escapeHtml(body).replaceAll("\n", "<br />")}</article>
      ${hashtags ? `<p>${escapeHtml(hashtags)}</p>` : ""}
      ${externalLink}
      <pre>${escapeHtml(json)}</pre>
      <p><a href="${escapeHtml(`${url}?format=json`)}">JSON</a></p>
    </main>
  </body>
</html>`;
}

function createDraftSummary(storedDraft: StoredDraft, request: IncomingMessage): DraftSummary {
  return {
    draftId: storedDraft.draftId,
    platform: storedDraft.platform,
    accountId: storedDraft.accountId,
    title: storedDraft.payload.draft?.title ?? storedDraft.payload.document?.title ?? storedDraft.draftId,
    createdAt: storedDraft.createdAt,
    updatedAt: storedDraft.updatedAt,
    state: storedDraft.state,
    externalDraftId: storedDraft.externalDraftId,
    externalDraftIdAliases: storedDraft.externalDraftIdAliases,
    externalUrl: storedDraft.externalUrl,
    statusDetail: storedDraft.statusDetail,
    url: createDraftUrl(storedDraft.platform, storedDraft.draftId, request),
  };
}

async function listStoredDrafts(platforms: string[], request: IncomingMessage) {
  const drafts = await Promise.all(
    platforms.map(async (platform) => {
      const platformOutboxDir = path.join(outboxDir, platform);
      if (!existsSync(platformOutboxDir)) {
        return [];
      }

      const fileNames = await readdir(platformOutboxDir);
      const storedDrafts = await Promise.all(
        fileNames
          .filter((fileName) => fileName.endsWith(".json"))
          .map((fileName) => readStoredDraft(platform, fileName.replace(/\.json$/, ""))),
      );

      return storedDrafts
        .filter((storedDraft): storedDraft is StoredDraft => Boolean(storedDraft))
        .map((storedDraft) => createDraftSummary(storedDraft, request));
    }),
  );

  return drafts
    .flat()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function renderDraftListHtml(items: DraftSummary[], title: string) {
  const content =
    items.length > 0
      ? `<div class="list">${items
          .map(
            (item) => `<a class="draft-row" href="${escapeHtml(item.url)}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.platform)} / ${escapeHtml(item.state)} / ${escapeHtml(item.accountId ?? "unknown")} / ${escapeHtml(item.updatedAt)}</span>
          ${item.externalUrl ? `<span>External: ${escapeHtml(item.externalUrl)}</span>` : ""}
        </a>`,
          )
          .join("")}</div>`
      : `<p class="empty">No drafts have been stored yet.</p>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f7f7f4; }
      main { width: min(960px, calc(100vw - 32px)); margin: 32px auto; }
      .toolbar { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 20px; }
      .toolbar a, .draft-row { background: #fff; border: 1px solid #d7d7cf; border-radius: 8px; color: inherit; text-decoration: none; }
      .toolbar a { padding: 8px 12px; }
      .list { display: grid; gap: 10px; }
      .draft-row { display: grid; gap: 6px; padding: 16px; }
      .draft-row span, .empty { color: #626a73; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="toolbar">
        <a href="/drafts">All</a>
        ${Array.from(supportedPlatforms)
          .map((platform) => `<a href="/${escapeHtml(platform)}/drafts">${escapeHtml(platform)}</a>`)
          .join("")}
        <a href="/drafts?format=json">JSON</a>
        <a href="/contract">Upstream contract</a>
      </div>
      ${content}
    </main>
  </body>
</html>`;
}

async function handleCreateDraft(platform: string, request: IncomingMessage, response: ServerResponse) {
  if (!requireAuthorized(request)) {
    sendJson(response, 401, { ok: false, message: "Draft connector API key is invalid." });
    return;
  }

  const payload = (await readJsonBody(request)) as DraftPayload;
  const validationError = validateDraftPayload(platform, payload);
  if (validationError) {
    sendJson(response, 422, { ok: false, message: validationError });
    return;
  }

  const upstreamConfig = resolveUpstreamDraftConfig(platform);
  const existingDraft = await findStoredDraftByExecution(platform, payload.execution);
  if (existingDraft) {
    if (upstreamConfig && shouldResumeUpstreamForwarding(existingDraft, upstreamConfig)) {
      sendJson(response, 200, await forwardStoredDraftToUpstream(existingDraft, payload, request, upstreamConfig));
      return;
    }

    sendJson(response, 200, createStoredDraftResponse(existingDraft, request));
    return;
  }

  const draftId = createDraftId(platform, payload.execution);
  const createdAt = new Date().toISOString();
  const storedDraft: StoredDraft = {
    draftId,
    platform,
    accountId: payload.accountId,
    createdAt,
    updatedAt: createdAt,
    state: upstreamConfig ? "publishing" : "draft",
    statusDetail: upstreamConfig ? `${platform} draft is being forwarded to an upstream draft service.` : undefined,
    payload: sanitizeDraftPayload(payload),
  };

  const stored = await writeStoredDraftIfAbsent(storedDraft);
  if (!stored) {
    const concurrentDraft = await readStoredDraft(platform, draftId);
    if (concurrentDraft) {
      sendJson(response, 200, createStoredDraftResponse(concurrentDraft, request));
      return;
    }

    throw new Error(`${platform} draft ${draftId} was reserved concurrently but could not be read.`);
  }

  if (upstreamConfig) {
    sendJson(response, 200, await forwardStoredDraftToUpstream(storedDraft, payload, request, upstreamConfig));
    return;
  }

  const draftUrl = createDraftUrl(platform, draftId, request);
  sendJson(response, 200, {
    ok: true,
    draftId,
    remoteId: draftId,
    url: draftUrl,
    message: `${platform} draft stored in local outbox.`,
  });
}

async function handleUpdateDraftStatus(platform: string, draftId: string | undefined, request: IncomingMessage, response: ServerResponse) {
  if (!requireStatusCallbackAuthorized(request)) {
    sendJson(response, 401, { ok: false, message: "Draft connector status callback API key is invalid." });
    return;
  }

  const validDraftId = validateDraftId(draftId);
  if (!validDraftId) {
    sendJson(response, 422, { ok: false, message: "Draft status route must include a valid draft id." });
    return;
  }

  const storedDraft = await readStoredDraft(platform, validDraftId);
  if (!storedDraft) {
    sendJson(response, 404, {
      ok: false,
      message: `${platform} draft ${validDraftId} was not found in local outbox.`,
      remoteId: validDraftId,
    });
    return;
  }

  const payload = (await readJsonBody(request)) as Record<string, unknown>;
  const state = normalizeDraftState(payload.state);
  if (!state) {
    sendJson(response, 422, {
      ok: false,
      message: `Draft status state must be one of: ${Array.from(supportedDraftStates).join(", ")}.`,
    });
    return;
  }

  const externalDraftId = readOptionalString(payload.externalDraftId) ?? readOptionalString(payload.remoteId);
  const externalUrl = readOptionalString(payload.externalUrl) ?? readOptionalString(payload.url);
  const statusDetail = readOptionalString(payload.detail);
  const statusIssues = Array.isArray(payload.issues) ? payload.issues.filter(isValidationIssue) : undefined;
  const nextExternalDraftId = externalDraftId ?? storedDraft.externalDraftId;
  const updatedDraft: StoredDraft = {
    ...storedDraft,
    state,
    externalDraftId: nextExternalDraftId,
    externalDraftIdAliases: createExternalDraftIdAliases(storedDraft, nextExternalDraftId),
    externalUrl: externalUrl ?? storedDraft.externalUrl,
    statusDetail: statusDetail ?? storedDraft.statusDetail,
    statusIssues: statusIssues ?? storedDraft.statusIssues,
    updatedAt: new Date().toISOString(),
  };

  await writeStoredDraft(updatedDraft);

  sendJson(response, 200, {
    ok: true,
    draftId: updatedDraft.draftId,
    remoteId: updatedDraft.externalDraftId ?? updatedDraft.draftId,
    state: updatedDraft.state,
    url: updatedDraft.externalUrl ?? createDraftUrl(platform, updatedDraft.draftId, request),
    detail: updatedDraft.statusDetail,
    issues: updatedDraft.statusIssues,
  });
}

async function handleGetDraft(platform: string, draftId: string | undefined, request: IncomingMessage, response: ServerResponse) {
  const validDraftId = validateDraftId(draftId);
  if (!validDraftId) {
    sendJson(response, 422, { ok: false, message: "Draft route must include a valid draft id." });
    return;
  }

  const storedDraft = await readStoredDraft(platform, validDraftId);
  if (!storedDraft) {
    sendJson(response, 404, {
      ok: false,
      message: `${platform} draft ${validDraftId} was not found in local outbox.`,
      remoteId: validDraftId,
    });
    return;
  }

  const url = createDraftUrl(platform, storedDraft.draftId, request);
  if (shouldReturnJson(request)) {
    sendJson(response, 200, { ok: true, url, ...storedDraft });
    return;
  }

  sendHtml(response, 200, renderDraftHtml(storedDraft, url));
}

async function handleListDrafts(platform: string | undefined, request: IncomingMessage, response: ServerResponse) {
  const platforms = platform ? [platform] : Array.from(supportedPlatforms);
  const items = await listStoredDrafts(platforms, request);
  const title = platform ? `${platform} drafts` : "Draft connector outbox";

  if (shouldReturnJson(request)) {
    sendJson(response, 200, { ok: true, outboxDir, items });
    return;
  }

  sendHtml(response, 200, renderDraftListHtml(items, title));
}

async function handleDraftStatus(platform: string, request: IncomingMessage, response: ServerResponse) {
  if (!requireAuthorized(request)) {
    sendJson(response, 401, { state: "needs_manual_action", detail: "Draft connector API key is invalid." });
    return;
  }

  const payload = (await readJsonBody(request)) as { remoteId?: string };
  if (!payload.remoteId) {
    sendJson(response, 422, { state: "needs_manual_action", detail: "Status payload must include remoteId." });
    return;
  }

  const validRemoteId = validateRemoteId(payload.remoteId);
  if (!validRemoteId) {
    sendJson(response, 422, { state: "needs_manual_action", detail: "Status payload remoteId is invalid." });
    return;
  }

  const storedDraft = await findStoredDraftByRemoteId(platform, validRemoteId);
  if (!storedDraft) {
    sendJson(response, 404, {
      state: "needs_manual_action",
      detail: `${platform} draft ${validRemoteId} was not found in local outbox.`,
      remoteId: validRemoteId,
    });
    return;
  }

  const refreshedDraft = await refreshStoredDraftFromUpstreamStatus(storedDraft, payload, request);

  sendJson(response, 200, {
    state: refreshedDraft.state,
    detail: refreshedDraft.statusDetail ?? `${platform} draft is stored in local outbox.`,
    remoteId: refreshedDraft.externalDraftId ?? refreshedDraft.draftId,
    url: refreshedDraft.externalUrl ?? createDraftUrl(platform, refreshedDraft.draftId, request),
    issues: refreshedDraft.statusIssues,
  });
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const { platform: routePlatform, operation, draftId, action } = parseRoute(request.url);
      const platform = validatePlatform(routePlatform);

      if (request.method === "GET" && request.url === "/health") {
        const platforms = Array.from(supportedPlatforms);
        const baseUrl = resolvePublicBaseUrl(request);
        sendJson(response, 200, {
          status: "ok",
          outboxDir,
          platforms,
          contractVersion: "draft-connector-upstream-v1",
          contractUrl: `${baseUrl}/contract`,
          outbox: await summarizeOutbox(platforms),
          upstreamDrafts: await listUpstreamDraftStatuses(),
        });
        return;
      }

      if (request.method === "GET" && routePlatform === "contract") {
        sendJson(response, 200, createUpstreamContract(request));
        return;
      }

      if (request.method === "GET" && routePlatform === "drafts") {
        await handleListDrafts(undefined, request, response);
        return;
      }

      if (!platform) {
        sendJson(response, 404, { ok: false, message: "Unsupported draft connector platform." });
        return;
      }

      if (request.method === "POST" && operation === "drafts" && draftId && action === "status") {
        await handleUpdateDraftStatus(platform, draftId, request, response);
        return;
      }

      if (request.method === "POST" && operation === "drafts" && !draftId) {
        await handleCreateDraft(platform, request, response);
        return;
      }

      if (request.method === "GET" && operation === "drafts") {
        if (draftId) {
          await handleGetDraft(platform, draftId, request, response);
          return;
        }

        await handleListDrafts(platform, request, response);
        return;
      }

      if (request.method === "POST" && operation === "status") {
        await handleDraftStatus(platform, request, response);
        return;
      }

      sendJson(response, 404, { ok: false, message: "Draft connector route not found." });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Unknown draft connector error.",
      });
    }
  })();
});

server.listen(port, () => {
  console.log(`draft connector listening on ${port}`);
  console.log(`draft outbox: ${outboxDir}`);
});
