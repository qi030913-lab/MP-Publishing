#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceEnv } from "./lib/workspace-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadWorkspaceEnv({ root });
const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

const usageText = `Usage:
  pnpm drafts:capture-playwright-session -- --platform zhihu --url https://creator.example.test/drafts/new --save-env

Options:
  --platform <platform>            Required: zhihu, bilibili, or xiaohongshu.
  --url <url>                      Creator page to open; defaults to DRAFT_AUTOMATION_<PLATFORM>_CREATOR_DRAFT_URL.
  --output <path>                  Defaults to .runtime/draft-sessions/<platform>-storage-state.json.
  --wait-for-selector <selector>   Wait for a post-login selector before saving storage state.
  --wait-ms <ms>                   Fixed wait before saving when no selector is provided; defaults to 15000.
  --timeout-ms <ms>                Overrides DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS.
  --headless                       Capture without an interactive browser window.
  --browser-channel <value>        Browser channel to launch; defaults to DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL.
  --save-env                       Write STORAGE_STATE_PATH, CREATOR_DRAFT_URL, and REQUIRE_SESSION to .env.
  --target-env-file <path>         Defaults to .env when --save-env is used.
  --selectors-path <path>          Optional selector file path to write to .env.
  --help

Environment:
  DRAFT_AUTOMATION_PLAYWRIGHT_MODULE may point to a custom Playwright-compatible module.

Storage state files contain live platform cookies. Keep them under ignored local paths such as .runtime.`;

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

function requirePlatform(value) {
  const platform = String(value ?? "").trim();
  if (!supportedPlatforms.has(platform)) {
    throw new Error("--platform must be one of zhihu, bilibili, xiaohongshu.");
  }

  return platform;
}

function requireHttpUrl(value, label) {
  if (!value) {
    throw new Error(`${label} is required.`);
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }

  return url.href;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function quoteEnvValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function updateEnvContent(content, updates) {
  const remaining = new Map(updates);
  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!remaining.has(key)) {
      return line;
    }

    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${quoteEnvValue(value)}`;
  });

  if (remaining.size > 0) {
    if (lines.at(-1)?.trim()) {
      lines.push("");
    }

    lines.push("# Playwright creator-center session capture.");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

async function writeEnvFile(envPath, updates) {
  const examplePath = path.join(root, ".env.example");
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      throw new Error(`Cannot create ${envPath}; .env.example is missing.`);
    }

    await mkdir(path.dirname(envPath), { recursive: true });
    await copyFile(examplePath, envPath);
  }

  const current = await readFile(envPath, "utf8");
  await writeFile(envPath, updateEnvContent(current, updates), "utf8");
}

async function importPlaywright() {
  const moduleName = readEnv("DRAFT_AUTOMATION_PLAYWRIGHT_MODULE") ?? "playwright";
  const loaded = await import(moduleName);
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  if (!chromium?.launch) {
    throw new Error(`${moduleName} must export chromium.launch().`);
  }

  return { chromium };
}

function parseCookieHeader(cookies, url) {
  if (!cookies) {
    return [];
  }

  const parsedUrl = new URL(url);
  return cookies
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      const name = separator > -1 ? part.slice(0, separator).trim() : part;
      const value = separator > -1 ? part.slice(separator + 1).trim() : "";
      return {
        name,
        value,
        domain: parsedUrl.hostname,
        path: "/",
        httpOnly: false,
        secure: parsedUrl.protocol === "https:",
        sameSite: "Lax",
      };
    });
}

function readInitialStorageState(platform, args) {
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const storageStatePath = readOption(args, "storage-state-path", [
    `${envPrefix}_STORAGE_STATE_PATH`,
    `${envPrefix}_STORAGE_STATE_FILE`,
  ]);
  if (storageStatePath) {
    return resolvePath(storageStatePath);
  }

  const storageStateJson = readOption(args, "storage-state-json", [`${envPrefix}_STORAGE_STATE_JSON`]);
  if (storageStateJson) {
    return JSON.parse(storageStateJson);
  }

  return undefined;
}

async function captureSession(options) {
  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({
    headless: options.headless,
    ...(options.browserChannel ? { channel: options.browserChannel } : {}),
  });

  try {
    const context = await browser.newContext({
      ...(options.initialStorageState ? { storageState: options.initialStorageState } : {}),
    });
    if (options.cookies) {
      const cookies = parseCookieHeader(options.cookies, options.url);
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }

    const page = await context.newPage();
    page.setDefaultTimeout?.(options.timeoutMs);
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });

    if (options.waitForSelector) {
      await page.locator(options.waitForSelector).waitFor({ timeout: options.timeoutMs });
    } else if (options.waitMs > 0) {
      await page.waitForTimeout?.(options.waitMs);
    }

    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await context.storageState({ path: options.outputPath });
    return page.url();
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const platform = requirePlatform(readOption(args, "platform"));
  const envPrefix = `DRAFT_AUTOMATION_${platform.toUpperCase()}`;
  const url = requireHttpUrl(
    readOption(args, "url", [`${envPrefix}_CREATOR_DRAFT_URL`, `${envPrefix}_CREATOR_BASE_URL`]),
    "--url or DRAFT_AUTOMATION_<PLATFORM>_CREATOR_DRAFT_URL",
  );
  const outputPath = resolvePath(
    readOption(args, "output", [`${envPrefix}_CAPTURE_STORAGE_STATE_PATH`]) ??
      `.runtime/draft-sessions/${platform}-storage-state.json`,
  );
  const waitForSelector = readOption(args, "wait-for-selector", [`${envPrefix}_CAPTURE_WAIT_FOR_SELECTOR`]);
  const timeoutMs = parseNonNegativeInteger(
    readOption(args, "timeout-ms", ["DRAFT_AUTOMATION_PLAYWRIGHT_TIMEOUT_MS"]) ?? "30000",
    "--timeout-ms",
  );
  const waitMs = parseNonNegativeInteger(
    readOption(args, "wait-ms", [`${envPrefix}_CAPTURE_WAIT_MS`, "DRAFT_AUTOMATION_PLAYWRIGHT_CAPTURE_WAIT_MS"]) ?? "15000",
    "--wait-ms",
  );
  const browserChannel = readOption(args, "browser-channel", ["DRAFT_AUTOMATION_PLAYWRIGHT_BROWSER_CHANNEL"]);
  const headless = readBoolean(args, "headless", ["DRAFT_AUTOMATION_PLAYWRIGHT_CAPTURE_HEADLESS"]);
  const cookies = readOption(args, "cookies", [`${envPrefix}_COOKIES`]);
  const initialStorageState = readInitialStorageState(platform, args);

  const finalUrl = await captureSession({
    platform,
    url,
    outputPath,
    waitForSelector,
    timeoutMs,
    waitMs,
    browserChannel,
    headless,
    cookies,
    initialStorageState,
  });

  const saveEnv = readBoolean(args, "save-env");
  const selectorsPath = readOption(args, "selectors-path", [`${envPrefix}_PLAYWRIGHT_SELECTORS_PATH`]);
  if (saveEnv) {
    const envPath = resolvePath(readOption(args, "target-env-file", ["DRAFT_AUTOMATION_CAPTURE_ENV_FILE"]) ?? ".env");
    const updates = new Map([
      [`${envPrefix}_CREATOR_DRAFT_URL`, url],
      [`${envPrefix}_STORAGE_STATE_PATH`, path.relative(root, outputPath).replaceAll("\\", "/")],
      [`${envPrefix}_REQUIRE_SESSION`, "true"],
    ]);
    if (selectorsPath) {
      updates.set(`${envPrefix}_PLAYWRIGHT_SELECTORS_PATH`, path.relative(root, resolvePath(selectorsPath)).replaceAll("\\", "/"));
    }
    await writeEnvFile(envPath, updates);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        platform,
        url,
        finalUrl,
        outputPath,
        savedEnv: saveEnv,
        hasInitialStorageState: Boolean(initialStorageState),
        hasCookieSeed: Boolean(cookies),
        waitedForSelector: waitForSelector,
        headless,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
