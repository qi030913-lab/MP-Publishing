#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadWorkspaceEnv } from "./lib/workspace-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadWorkspaceEnv({ root });

const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

const usageText = `Usage:
  pnpm drafts:smoke-playwright -- --platform zhihu

Options:
  --platform <platforms>           Required comma-separated subset: zhihu,bilibili,xiaohongshu.
  --title <value>                  Draft title; defaults to a timestamped smoke title.
  --summary <value>                Optional draft summary.
  --body <value>                   Draft body; defaults to a safe smoke body.
  --tags <csv>                     Optional hashtags/topics; defaults to mp-publishing,draft-smoke.
  --account-id <id>                Optional platform account id.
  --remote-id-prefix <value>       Defaults to playwright-smoke.
  --handler-module <path>          Defaults to scripts/handlers/playwright-draft-handler.mjs.
  --timeout-ms <ms>                Overrides DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS.
  --headed                         Runs the browser with DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS=false.
  --headless                       Runs the browser with DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS=true.
  --browser-channel <value>        Sets DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL.
  --click-save                     Forces the handler to click the configured save-draft selector.
  --no-click-save                  Fill-only smoke; does not save the platform draft.
  --allow-missing-session          Do not fail before browser launch when no session material is configured.
  --help

The command loads workspace .env by default. It never clicks a final publish button; the built-in handler only fills the creator page and optionally clicks the configured save-draft selector.`;

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

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readOption(args, name, envNames = []) {
  if (args[name] !== undefined) {
    return args[name] === true ? "" : String(args[name]);
  }

  for (const envName of envNames) {
    const value = readEnv(envName);
    if (value) {
      return value;
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

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

function parsePlatforms(value) {
  const platforms = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (platforms.length === 0) {
    throw new Error("--platform is required.");
  }

  const invalid = platforms.filter((platform) => !supportedPlatforms.has(platform));
  if (invalid.length > 0) {
    throw new Error(`Unsupported platform(s): ${invalid.join(", ")}`);
  }

  return [...new Set(platforms)];
}

function resolvePath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function parseTags(value) {
  return String(value ?? "mp-publishing,draft-smoke")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function hasSessionMaterial(session) {
  return Boolean(
    session.accessToken ||
      session.refreshToken ||
      session.cookies ||
      session.storageStateJson ||
      session.storageStatePath ||
      (session.appId && session.appSecret),
  );
}

function readPlatformSession(platform, args) {
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const session = {
    platform,
    required:
      !readBoolean(args, "allow-missing-session") &&
      (readBoolean(args, "require-session", ["DRAFT_AUTOMATION_REQUIRE_SESSION"]) ||
        readBoolean(args, `${platform}-require-session`, [`${envPrefix}_REQUIRE_SESSION`]) ||
        true),
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
    storageStatePath: readOption(args, `${platform}-storage-state-path`, [`${envPrefix}_STORAGE_STATE_PATH`, `${envPrefix}_STORAGE_STATE_FILE`]),
    expiresAt: readOption(args, `${platform}-expires-at`, [`${envPrefix}_EXPIRES_AT`]),
  };

  const ready = hasSessionMaterial(session);
  return {
    ...session,
    storageStatePath: session.storageStatePath ? resolvePath(session.storageStatePath) : undefined,
    ready,
  };
}

function summarizeSession(session) {
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

function applyPlaywrightOverrides(args, platform) {
  if (args["timeout-ms"] !== undefined) {
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS = String(parseNonNegativeInteger(args["timeout-ms"], "--timeout-ms"));
  }

  if (args.headed && args.headless) {
    throw new Error("--headed and --headless cannot be used together.");
  }

  if (args.headed) {
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS = "false";
  }
  if (args.headless) {
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS = "true";
  }

  if (args["browser-channel"] !== undefined) {
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL = String(args["browser-channel"]);
  }

  if (args["click-save"] && args["no-click-save"]) {
    throw new Error("--click-save and --no-click-save cannot be used together.");
  }

  if (args["click-save"]) {
    process.env[`DRAFT_AUTOMATION_${platform.toUpperCase()}_PLAYWRIGHT_CLICK_SAVE`] = "true";
  }
  if (args["no-click-save"]) {
    process.env[`DRAFT_AUTOMATION_${platform.toUpperCase()}_PLAYWRIGHT_CLICK_SAVE`] = "false";
  }
}

async function loadHandler(handlerModulePath) {
  const loaded = await import(pathToFileURL(resolvePath(handlerModulePath)).href);
  const handler = loaded.createDraft ?? loaded.default?.createDraft ?? loaded.default;
  if (typeof handler !== "function") {
    throw new Error("--handler-module must export createDraft(input) or a default handler function.");
  }

  return handler;
}

function createSmokeWorkOrder({ platform, args, now }) {
  const remoteIdPrefix = sanitizeSegment(readOption(args, "remote-id-prefix") ?? "playwright-smoke");
  const remoteId = `${remoteIdPrefix}-${platform}-${now.replace(/[^0-9TZ]/g, "").toLowerCase()}`;
  const title = readOption(args, "title") ?? `MP Publishing Playwright draft smoke ${now}`;
  const summary = readOption(args, "summary") ?? "Creator-center draft smoke check.";
  const body =
    readOption(args, "body") ??
    "This draft was created by MP Publishing's Playwright smoke check. It is intended to remain a draft and must not be published.";
  const hashtags = parseTags(readOption(args, "tags"));
  const renderedBody = [summary, body, hashtags.length > 0 ? hashtags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ") : undefined]
    .filter(Boolean)
    .join("\n\n");

  return {
    version: "draft-upstream-work-order-v1",
    platform,
    remoteId,
    accountId: readOption(args, "account-id", [`DRAFT_AUTOMATION_${platform.toUpperCase()}_ACCOUNT_ID`]),
    connector: {
      draftId: remoteId,
      draftUrl: `https://connector.example.test/${platform}/drafts/${remoteId}`,
      statusCallbackUrl: `https://connector.example.test/${platform}/drafts/${remoteId}/status`,
    },
    draft: {
      title,
      summary,
      body,
      hashtags,
      warnings: [],
      renderedBody,
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
    },
    checklist: [
      { id: "open-creator-center", label: "Open creator center.", required: true },
      { id: "fill-title", label: "Fill title.", required: true, sourceField: "draft.title" },
      { id: "fill-body", label: "Fill body.", required: true, sourceField: "draft.body" },
      { id: "apply-tags", label: "Apply tags when supported.", required: false, sourceField: "draft.hashtags" },
      { id: "save-draft", label: "Save as draft and capture the draft URL.", required: true },
    ],
  };
}

async function runPlatformSmoke({ platform, args, handler, now }) {
  applyPlaywrightOverrides(args, platform);
  const platformSession = readPlatformSession(platform, args);
  if (platformSession.required && !platformSession.ready) {
    throw new Error(`${platform} session is required but no configured session material was found.`);
  }

  const sessionSummary = summarizeSession(platformSession);
  const workOrder = createSmokeWorkOrder({ platform, args, now });
  const result = await handler({
    platform,
    accountId: workOrder.accountId,
    workOrder,
    requestedAt: now,
    runner: {
      completedBy: "playwright-smoke",
      safeMode: true,
      source: "drafts:smoke-playwright",
    },
    platformSession,
    sessionSummary,
    context: {
      fallback: {
        remoteId: workOrder.remoteId,
        url: workOrder.connector.draftUrl,
        state: "ready",
        detail: `${platform} Playwright smoke fallback.`,
      },
    },
  });

  return {
    ok: result?.ok !== false,
    platform,
    remoteId: result?.remoteId,
    url: result?.url,
    state: result?.state,
    detail: result?.detail,
    session: sessionSummary,
    clickSave: process.env[`DRAFT_AUTOMATION_${platform.toUpperCase()}_PLAYWRIGHT_CLICK_SAVE`] ?? process.env.DRAFT_AUTOMATION_PLAYWRIGHT_CLICK_SAVE ?? "default",
    workOrder: {
      remoteId: workOrder.remoteId,
      title: workOrder.draft.title,
      checklist: workOrder.checklist.map((item) => ({ id: item.id, required: item.required })),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const platforms = parsePlatforms(readOption(args, "platform", ["DRAFT_AUTOMATION_PLAYWRIGHT_SMOKE_PLATFORMS"]));
  const handlerModulePath = readOption(args, "handler-module", ["DRAFT_AUTOMATION_PLAYWRIGHT_SMOKE_HANDLER_MODULE"]) ??
    "scripts/handlers/playwright-draft-handler.mjs";
  const handler = await loadHandler(handlerModulePath);
  const now = new Date().toISOString();
  const results = [];

  for (const platform of platforms) {
    try {
      results.push(await runPlatformSmoke({ platform, args, handler, now }));
    } catch (error) {
      results.push({
        ok: false,
        platform,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), handlerModulePath, results }, null, 2));
  if (!ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
