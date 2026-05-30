#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDraftSetup } from "./handlers/playwright-draft-handler.mjs";
import { loadWorkspaceEnv } from "./lib/workspace-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadWorkspaceEnv({ root });
const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

const usageText = `Usage:
  pnpm drafts:check-playwright -- --platform zhihu

Options:
  --platform <platforms>           Required comma-separated subset: zhihu,bilibili,xiaohongshu.
  --screenshot-dir <path>          Optional directory for per-platform page screenshots.
  --timeout-ms <ms>                Overrides DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS.
  --headed                         Runs the browser with DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS=false.
  --browser-channel <value>        Sets DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL.
  --require-session                Fails before browser launch when no session material is configured.
  --skip-optional-selectors        Only check required title/body selectors.
  --help

Environment:
  DRAFT_AUTOMATION_<PLATFORM>_CREATOR_DRAFT_URL
  DRAFT_AUTOMATION_<PLATFORM>_COOKIES
  DRAFT_AUTOMATION_<PLATFORM>_STORAGE_STATE_JSON
  DRAFT_AUTOMATION_<PLATFORM>_STORAGE_STATE_PATH
  DRAFT_AUTOMATION_<PLATFORM>_PLAYWRIGHT_SELECTORS_JSON or *_SELECTORS_PATH`;

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

  return platforms;
}

function resolveOptionalPath(value) {
  if (!value) {
    return undefined;
  }

  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
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
      readBoolean(args, "require-session", ["DRAFT_AUTOMATION_REQUIRE_SESSION"]) ||
      readBoolean(args, `${platform}-require-session`, [`${envPrefix}_REQUIRE_SESSION`]),
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
  };

  return {
    ...session,
    ready: hasSessionMaterial(session),
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

function applyPlaywrightOverrides(args) {
  if (args["timeout-ms"] !== undefined) {
    const value = Number.parseInt(String(args["timeout-ms"]), 10);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("--timeout-ms must be a non-negative integer.");
    }
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS = String(value);
  }

  if (args.headed) {
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS = "false";
  }

  if (args["browser-channel"] !== undefined) {
    process.env.DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL = String(args["browser-channel"]);
  }
}

async function runPlatformCheck(platform, args) {
  const platformSession = readPlatformSession(platform, args);
  if (platformSession.required && !platformSession.ready) {
    throw new Error(`${platform} session is required but no configured session material was found.`);
  }

  const screenshotDir = resolveOptionalPath(readOption(args, "screenshot-dir", ["DRAFT_AUTOMATION_PLAYWRIGHT_CHECK_SCREENSHOT_DIR"]));
  const screenshotPath = screenshotDir ? path.join(screenshotDir, `${platform}-draft-setup.png`) : undefined;
  const result = await checkDraftSetup({
    platform,
    platformSession,
    screenshotPath,
    includeOptionalSelectors: !readBoolean(args, "skip-optional-selectors"),
  });

  return {
    ...result,
    session: summarizeSession(platformSession),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  applyPlaywrightOverrides(args);
  const platforms = parsePlatforms(readOption(args, "platform", ["DRAFT_AUTOMATION_PLAYWRIGHT_CHECK_PLATFORMS"]));
  const results = [];

  for (const platform of platforms) {
    try {
      results.push(await runPlatformCheck(platform, args));
    } catch (error) {
      results.push({
        ok: false,
        platform,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), results }, null, 2));
  if (!ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
