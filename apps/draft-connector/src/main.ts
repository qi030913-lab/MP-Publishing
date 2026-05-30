import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

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
  return `${platform}-draft-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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

function requireAuthorized(request: IncomingMessage) {
  const apiKey = process.env.DRAFT_CONNECTOR_API_KEY?.trim();
  if (!apiKey) {
    return true;
  }

  return request.headers.authorization === `Bearer ${apiKey}`;
}

function parseRoute(url: string | undefined) {
  const parsed = new URL(url ?? "/", "http://localhost");
  const [platform, operation] = parsed.pathname.split("/").filter(Boolean);
  return { platform, operation };
}

function validatePlatform(platform: string | undefined) {
  return platform && supportedPlatforms.has(platform) ? platform : null;
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
    url: `draft-outbox://${platform}/${draftId}`,
    message: `${platform} draft stored in local outbox.`,
  });
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

  const filePath = path.join(outboxDir, platform, `${payload.remoteId}.json`);
  if (!existsSync(filePath)) {
    sendJson(response, 404, {
      state: "needs_manual_action",
      detail: `${platform} draft ${payload.remoteId} was not found in local outbox.`,
      remoteId: payload.remoteId,
    });
    return;
  }

  const storedDraft = JSON.parse(await readFile(filePath, "utf8")) as StoredDraft;
  sendJson(response, 200, {
    state: "draft",
    detail: `${platform} draft is stored in local outbox.`,
    remoteId: storedDraft.draftId,
    url: `draft-outbox://${platform}/${storedDraft.draftId}`,
  });
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      const { platform: routePlatform, operation } = parseRoute(request.url);
      const platform = validatePlatform(routePlatform);

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, {
          status: "ok",
          outboxDir,
          platforms: Array.from(supportedPlatforms),
        });
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

const port = Number(process.env.PORT ?? 3010);
server.listen(port, () => {
  console.log(`draft connector listening on ${port}`);
  console.log(`draft outbox: ${outboxDir}`);
});
