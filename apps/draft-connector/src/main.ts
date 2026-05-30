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
    body?: string;
  };
  requestedAt?: string;
};

type StoredDraft = {
  draftId: string;
  platform: string;
  accountId?: string;
  createdAt: string;
  payload: DraftPayload;
};

type DraftSummary = {
  draftId: string;
  platform: string;
  accountId?: string;
  title: string;
  createdAt: string;
  url: string;
};

const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);
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

function requireAuthorized(request: IncomingMessage) {
  const apiKey = process.env.DRAFT_CONNECTOR_API_KEY?.trim();
  if (!apiKey) {
    return true;
  }

  return request.headers.authorization === `Bearer ${apiKey}`;
}

function parseRoute(url: string | undefined) {
  const parsed = new URL(url ?? "/", "http://localhost");
  const [platform, operation, draftId] = parsed.pathname.split("/").filter(Boolean);
  return { platform, operation, draftId };
}

function validatePlatform(platform: string | undefined) {
  return platform && supportedPlatforms.has(platform) ? platform : null;
}

function validateDraftId(draftId: string | undefined) {
  return draftId && /^[a-z0-9-]+$/i.test(draftId) ? draftId : null;
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

async function readStoredDraft(platform: string, draftId: string) {
  const filePath = path.join(outboxDir, platform, `${draftId}.json`);
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8")) as StoredDraft;
}

function shouldReturnJson(request: IncomingMessage) {
  const parsed = new URL(request.url ?? "/", "http://localhost");
  const accept = firstHeaderValue(request.headers.accept) ?? "";
  return parsed.searchParams.get("format") === "json" || accept.includes("application/json");
}

function renderDraftHtml(storedDraft: StoredDraft, url: string) {
  const title = storedDraft.payload.draft?.title ?? storedDraft.payload.document?.title ?? storedDraft.draftId;
  const body = storedDraft.payload.draft?.body ?? "";
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
        <div><span>Draft ID</span><strong>${escapeHtml(storedDraft.draftId)}</strong></div>
        <div><span>Created</span><strong>${escapeHtml(storedDraft.createdAt)}</strong></div>
      </div>
      <article>${escapeHtml(body).replaceAll("\n", "<br />")}</article>
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
            return JSON.parse(content) as StoredDraft;
          }),
      );

      return storedDrafts.map((storedDraft) => createDraftSummary(storedDraft, request));
    }),
  );

  return drafts
    .flat()
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function renderDraftListHtml(items: DraftSummary[], title: string) {
  const content =
    items.length > 0
      ? `<div class="list">${items
          .map(
            (item) => `<a class="draft-row" href="${escapeHtml(item.url)}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.platform)} · ${escapeHtml(item.accountId ?? "unknown")} · ${escapeHtml(item.createdAt)}</span>
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
  const platformOutboxDir = path.join(outboxDir, platform);
  const filePath = path.join(platformOutboxDir, `${draftId}.json`);
  const storedDraft: StoredDraft = {
    draftId,
    platform,
    accountId: payload.accountId,
    createdAt: new Date().toISOString(),
    payload,
  };

  await mkdir(platformOutboxDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(storedDraft, null, 2)}\n`, "utf8");

  sendJson(response, 200, {
    ok: true,
    draftId,
    remoteId: draftId,
    url: createDraftUrl(platform, draftId, request),
    message: `${platform} draft stored in local outbox.`,
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

  const validDraftId = validateDraftId(payload.remoteId);
  if (!validDraftId) {
    sendJson(response, 422, { state: "needs_manual_action", detail: "Status payload remoteId is invalid." });
    return;
  }

  const storedDraft = await readStoredDraft(platform, validDraftId);
  if (!storedDraft) {
    sendJson(response, 404, {
      state: "needs_manual_action",
      detail: `${platform} draft ${validDraftId} was not found in local outbox.`,
      remoteId: validDraftId,
    });
    return;
  }

  sendJson(response, 200, {
    state: "draft",
    detail: `${platform} draft is stored in local outbox.`,
    remoteId: storedDraft.draftId,
    url: createDraftUrl(platform, storedDraft.draftId, request),
  });
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const { platform: routePlatform, operation, draftId } = parseRoute(request.url);
      const platform = validatePlatform(routePlatform);

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, {
          status: "ok",
          outboxDir,
          platforms: Array.from(supportedPlatforms),
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

      if (request.method === "POST" && operation === "drafts") {
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
