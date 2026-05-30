import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

type DraftPayload = {
  platform?: string;
  accountId?: string;
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
  externalUrl?: string;
  statusDetail?: string;
  url: string;
};

type UpstreamDraftConfig = {
  endpoint: string;
  healthEndpoint?: string;
  apiKey?: string;
  includeCredential: boolean;
};

type UpstreamDraftStatus = {
  platform: string;
  draftEndpointConfigured: boolean;
  healthEndpoint?: string;
  status: "unconfigured" | "configured" | "online" | "offline";
  detail?: string;
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
const port = Number(process.env.PORT ?? 3010);

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
const outboxDir = process.env.DRAFT_CONNECTOR_OUTBOX_DIR
  ? path.resolve(process.env.DRAFT_CONNECTOR_OUTBOX_DIR)
  : path.join(workspaceRoot, ".runtime", "drafts");

function createDraftId(platform: string) {
  return `${platform}-draft-${randomUUID()}`;
}

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isEnvEnabled(key: string) {
  return readEnvValue(key)?.toLowerCase() === "true";
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

function requireAuthorized(request: IncomingMessage) {
  const apiKey = process.env.DRAFT_CONNECTOR_API_KEY?.trim();
  if (!apiKey) {
    return true;
  }

  return request.headers.authorization === `Bearer ${apiKey}`;
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

function normalizeStoredDraft(raw: StoredDraft): StoredDraft {
  return {
    ...raw,
    state: normalizeDraftState(raw.state) ?? "draft",
    updatedAt: raw.updatedAt ?? raw.createdAt,
    statusIssues: normalizeIssues(raw.statusIssues),
  };
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
    healthEndpoint: readEnvValue(`${envPrefix}_HEALTH_ENDPOINT`) ?? readEnvValue("DRAFT_CONNECTOR_UPSTREAM_HEALTH_ENDPOINT"),
    apiKey: readEnvValue(`${envPrefix}_DRAFT_API_KEY`) ?? readEnvValue("DRAFT_CONNECTOR_UPSTREAM_API_KEY"),
    includeCredential: isEnvEnabled(`${envPrefix}_INCLUDE_CREDENTIAL`),
  };
}

async function probeUpstreamDraftStatus(platform: string): Promise<UpstreamDraftStatus> {
  const config = resolveUpstreamDraftConfig(platform);
  if (!config) {
    return {
      platform,
      draftEndpointConfigured: false,
      status: "unconfigured",
    };
  }

  if (!config.healthEndpoint) {
    return {
      platform,
      draftEndpointConfigured: true,
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

    return {
      platform,
      draftEndpointConfigured: true,
      healthEndpoint: config.healthEndpoint,
      status: response.ok ? "online" : "offline",
      detail: response.ok
        ? `Upstream draft health check returned HTTP ${response.status}.`
        : `Upstream draft health check failed with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      platform,
      draftEndpointConfigured: true,
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

function applyUpstreamDraftResponse(storedDraft: StoredDraft, payload: UpstreamDraftResponse): StoredDraft {
  const externalDraftId =
    readOptionalString(payload.externalDraftId) ?? readOptionalString(payload.remoteId) ?? readOptionalString(payload.draftId);
  const externalUrl = readOptionalString(payload.externalUrl) ?? readOptionalString(payload.url);
  const nextState = normalizeDraftState(payload.state) ?? (externalDraftId || externalUrl ? "ready" : storedDraft.state);
  const statusDetail = readOptionalString(payload.detail) ?? readOptionalString(payload.message) ?? storedDraft.statusDetail;
  const statusIssues = normalizeIssues(payload.issues);

  return {
    ...storedDraft,
    state: nextState,
    externalDraftId: externalDraftId ?? storedDraft.externalDraftId,
    externalUrl: externalUrl ?? storedDraft.externalUrl,
    statusDetail,
    statusIssues: statusIssues ?? storedDraft.statusIssues,
    updatedAt: new Date().toISOString(),
  };
}

async function readStoredDraft(platform: string, draftId: string) {
  const filePath = path.join(outboxDir, platform, `${draftId}.json`);
  if (!existsSync(filePath)) {
    return null;
  }

  return normalizeStoredDraft(JSON.parse(await readFile(filePath, "utf8")) as StoredDraft);
}

async function writeStoredDraft(storedDraft: StoredDraft) {
  const platformOutboxDir = path.join(outboxDir, storedDraft.platform);
  const filePath = path.join(platformOutboxDir, `${storedDraft.draftId}.json`);

  await mkdir(platformOutboxDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(storedDraft, null, 2)}\n`, "utf8");
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
    const content = await readFile(path.join(platformOutboxDir, fileName), "utf8");
    const storedDraft = normalizeStoredDraft(JSON.parse(content) as StoredDraft);
    if (storedDraft.externalDraftId === remoteId) {
      return storedDraft;
    }
  }

  return null;
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
          .map(async (fileName) => {
            const content = await readFile(path.join(platformOutboxDir, fileName), "utf8");
            return normalizeStoredDraft(JSON.parse(content) as StoredDraft);
          }),
      );

      return storedDrafts.map((storedDraft) => createDraftSummary(storedDraft, request));
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

  const draftId = createDraftId(platform);
  const createdAt = new Date().toISOString();
  const storedDraft: StoredDraft = {
    draftId,
    platform,
    accountId: payload.accountId,
    createdAt,
    updatedAt: createdAt,
    state: "draft",
    payload: sanitizeDraftPayload(payload),
  };

  await writeStoredDraft(storedDraft);

  const draftUrl = createDraftUrl(platform, draftId, request);
  const upstreamConfig = resolveUpstreamDraftConfig(platform);
  if (upstreamConfig) {
    const forwardingDraft: StoredDraft = {
      ...storedDraft,
      state: "publishing",
      statusDetail: `${platform} draft is being forwarded to an upstream draft service.`,
      updatedAt: new Date().toISOString(),
    };
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
              `${platform.toUpperCase()}_UPSTREAM_DRAFT_REJECTED`,
              upstreamPayload.message ?? upstreamPayload.detail ?? `${platform} upstream draft service rejected the draft.`,
            ),
          ],
        };
        await writeStoredDraft(rejectedDraft);
        sendJson(response, 200, {
          ok: false,
          draftId,
          remoteId: rejectedDraft.externalDraftId ?? draftId,
          url: rejectedDraft.externalUrl ?? draftUrl,
          message: rejectedDraft.statusDetail ?? `${platform} upstream draft service rejected the draft.`,
          issues: rejectedDraft.statusIssues,
        });
        return;
      }

      const updatedDraft = applyUpstreamDraftResponse(forwardingDraft, upstreamPayload);
      await writeStoredDraft(updatedDraft);
      sendJson(response, 200, {
        ok: true,
        draftId,
        remoteId: updatedDraft.externalDraftId ?? draftId,
        url: updatedDraft.externalUrl ?? draftUrl,
        message: updatedDraft.statusDetail ?? `${platform} draft forwarded to upstream draft service.`,
        issues: updatedDraft.statusIssues,
      });
      return;
    } catch (error) {
      const failedDraft: StoredDraft = {
        ...forwardingDraft,
        state: "needs_manual_action",
        statusDetail: error instanceof Error ? error.message : `${platform} upstream draft service failed.`,
        statusIssues: [
          createIssue(
            `${platform.toUpperCase()}_UPSTREAM_DRAFT_FAILED`,
            error instanceof Error ? error.message : `${platform} upstream draft service failed.`,
          ),
        ],
        updatedAt: new Date().toISOString(),
      };
      await writeStoredDraft(failedDraft);
      sendJson(response, 200, {
        ok: false,
        draftId,
        remoteId: draftId,
        url: draftUrl,
        message: failedDraft.statusDetail,
        issues: failedDraft.statusIssues,
      });
      return;
    }
  }

  sendJson(response, 200, {
    ok: true,
    draftId,
    remoteId: draftId,
    url: draftUrl,
    message: `${platform} draft stored in local outbox.`,
  });
}

async function handleUpdateDraftStatus(platform: string, draftId: string | undefined, request: IncomingMessage, response: ServerResponse) {
  if (!requireAuthorized(request)) {
    sendJson(response, 401, { ok: false, message: "Draft connector API key is invalid." });
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
  const updatedDraft: StoredDraft = {
    ...storedDraft,
    state,
    externalDraftId: externalDraftId ?? storedDraft.externalDraftId,
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

  sendJson(response, 200, {
    state: storedDraft.state,
    detail: storedDraft.statusDetail ?? `${platform} draft is stored in local outbox.`,
    remoteId: storedDraft.externalDraftId ?? storedDraft.draftId,
    url: storedDraft.externalUrl ?? createDraftUrl(platform, storedDraft.draftId, request),
    issues: storedDraft.statusIssues,
  });
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const { platform: routePlatform, operation, draftId, action } = parseRoute(request.url);
      const platform = validatePlatform(routePlatform);

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, {
          status: "ok",
          outboxDir,
          platforms: Array.from(supportedPlatforms),
          upstreamDrafts: await listUpstreamDraftStatuses(),
        });
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
