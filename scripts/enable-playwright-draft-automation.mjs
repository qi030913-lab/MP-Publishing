#!/usr/bin/env node

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platforms = ["zhihu", "bilibili", "xiaohongshu"];

const usageText = `Usage:
  pnpm drafts:enable-playwright-automation -- --automation-base-url http://localhost:3030 --api-key automation-secret

Options:
  --target-env-file <path>         Defaults to .env, or DRAFT_PLAYWRIGHT_AUTOMATION_ENV_FILE.
  --automation-base-url <url>      Defaults to DRAFT_PLAYWRIGHT_AUTOMATION_BASE_URL or http://localhost:3030.
  --connector-base-url <url>       Defaults to LOCAL_DRAFT_CONNECTOR_BASE_URL or http://localhost:3010.
  --public-base-url <url>          Optional DRAFT_CONNECTOR_PUBLIC_BASE_URL.
  --outbox-dir <path>              Defaults to LOCAL_DRAFT_OUTBOX_DIR or .runtime/drafts.
  --api-key <key>                  Defaults to DRAFT_PLAYWRIGHT_AUTOMATION_API_KEY or automation-secret.
  --platforms <list>               Comma-separated subset; defaults to zhihu,bilibili,xiaohongshu.
  --handler-module <path>          Defaults to scripts/handlers/playwright-draft-handler.mjs.
  --draft-path-template <path>     Defaults to /:platform/drafts.
  --health-path <path>             Defaults to /health.
  --include-credential             Forward adapter credentials through the connector to the automation service.
  --no-require-session             Do not set DRAFT_AUTOMATION_<PLATFORM>_REQUIRE_SESSION=true.
  --headed                         Set DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS=false.
  --headless                       Set DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS=true.
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

function failUsage(message) {
  console.error(`${message}\n\n${usageText}`);
  process.exit(2);
}

function requireHttpUrl(value, label) {
  if (!value) {
    failUsage(`${label} is required.`);
  }

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("URL must use http or https");
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    failUsage(`${label} must be a valid http(s) URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionalHttpUrl(value, label) {
  if (!value) {
    return undefined;
  }

  return requireHttpUrl(value, label);
}

function parsePlatforms(value) {
  const selected = value ? value.split(",").map((item) => item.trim()).filter(Boolean) : platforms;
  const unsupported = selected.filter((platform) => !platforms.includes(platform));
  if (unsupported.length > 0 || selected.length === 0) {
    failUsage(`--platforms must contain only: ${platforms.join(", ")}.`);
  }

  return [...new Set(selected)];
}

function quoteEnvValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function formatBoolean(value) {
  return value ? "true" : "false";
}

function joinUrl(baseUrl, pathTemplate, platform) {
  const pathPart = pathTemplate.replaceAll(":platform", platform).replaceAll("{platform}", platform);
  const normalizedPath = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  return `${baseUrl.replace(/\/+$/, "")}${normalizedPath}`;
}

function maybeAutomationPort(automationBaseUrl) {
  const url = new URL(automationBaseUrl);
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function createUpdates(options) {
  const updates = new Map([
    ["DRAFT_CONNECTOR_BASE_URL", options.connectorBaseUrl],
    ["DRAFT_CONNECTOR_OUTBOX_DIR", options.outboxDir],
    ["DRAFT_AUTOMATION_SERVICE_PORT", maybeAutomationPort(options.automationBaseUrl)],
    ["DRAFT_AUTOMATION_SERVICE_API_KEY", options.apiKey],
    ["DRAFT_AUTOMATION_SERVICE_HANDLER_MODULE", options.handlerModule],
    ["DRAFT_AUTOMATION_REQUIRE_SESSION", formatBoolean(options.requireSession)],
  ]);

  if (options.publicBaseUrl) {
    updates.set("DRAFT_CONNECTOR_PUBLIC_BASE_URL", options.publicBaseUrl);
  }

  if (options.headless !== undefined) {
    updates.set("DRAFT_AUTOMATION_PLAYWRIGHT_HEADLESS", formatBoolean(options.headless));
  }

  for (const platform of options.platforms) {
    const envPrefix = platform.toUpperCase();
    const upstreamPrefix = `DRAFT_CONNECTOR_${envPrefix}_UPSTREAM`;
    updates.set(`${envPrefix}_REAL_PUBLISH_ENABLED`, "true");
    updates.set(`${envPrefix}_DRAFT_INCLUDE_CREDENTIAL`, formatBoolean(options.includeCredential));
    updates.set(`${envPrefix}_STATUS_INCLUDE_CREDENTIAL`, "false");
    updates.set(`${upstreamPrefix}_DRAFT_ENDPOINT`, joinUrl(options.automationBaseUrl, options.draftPathTemplate, platform));
    updates.set(`${upstreamPrefix}_DRAFT_API_KEY`, options.apiKey);
    updates.set(`${upstreamPrefix}_HEALTH_ENDPOINT`, joinUrl(options.automationBaseUrl, options.healthPath, platform));
    updates.set(`${upstreamPrefix}_STATUS_ENDPOINT`, "");
    updates.set(`${upstreamPrefix}_STATUS_API_KEY`, "");
    updates.set(`${upstreamPrefix}_INCLUDE_CREDENTIAL`, formatBoolean(options.includeCredential));
    updates.set(`${upstreamPrefix}_STATUS_INCLUDE_CREDENTIAL`, "false");
    updates.set(`DRAFT_AUTOMATION_${envPrefix}_REQUIRE_SESSION`, formatBoolean(options.requireSession));
  }

  return updates;
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

    lines.push("# Playwright draft automation enablement for Zhihu, Bilibili, and Xiaohongshu.");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function printNextSteps(options, envPath) {
  console.log(`Enabled Playwright draft automation settings in ${path.relative(root, envPath) || ".env"}.`);
  console.log(`Platforms: ${options.platforms.join(", ")}`);
  console.log("Next:");
  console.log(`  pnpm drafts:automation-service -- --api-key <configured-key> --handler-module ${options.handlerModule} --require-session`);
  console.log("  pnpm --filter @mp-publishing/draft-connector dev");
  console.log(`  pnpm drafts:check-playwright -- --platform ${options.platforms.join(",")} --screenshot-dir .runtime/draft-playwright-checks`);
  console.log(`  pnpm drafts:smoke-playwright -- --platform ${options.platforms[0]} --headed`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  if (args.headed && args.headless) {
    failUsage("--headed and --headless cannot be used together.");
  }

  const targetEnvFile = path.resolve(root, readOption(args, "target-env-file", ["DRAFT_PLAYWRIGHT_AUTOMATION_ENV_FILE"]) ?? ".env");
  const options = {
    targetEnvFile,
    automationBaseUrl: requireHttpUrl(
      readOption(args, "automation-base-url", ["DRAFT_PLAYWRIGHT_AUTOMATION_BASE_URL"]) ?? "http://localhost:3030",
      "--automation-base-url",
    ),
    connectorBaseUrl: requireHttpUrl(
      readOption(args, "connector-base-url", ["LOCAL_DRAFT_CONNECTOR_BASE_URL"]) ?? "http://localhost:3010",
      "--connector-base-url",
    ),
    publicBaseUrl: optionalHttpUrl(readOption(args, "public-base-url", ["LOCAL_DRAFT_CONNECTOR_PUBLIC_BASE_URL"]), "--public-base-url"),
    outboxDir: readOption(args, "outbox-dir", ["LOCAL_DRAFT_OUTBOX_DIR"]) ?? ".runtime/drafts",
    apiKey: readOption(args, "api-key", ["DRAFT_PLAYWRIGHT_AUTOMATION_API_KEY"]) ?? "automation-secret",
    platforms: parsePlatforms(readOption(args, "platforms")),
    handlerModule: readOption(args, "handler-module", ["DRAFT_PLAYWRIGHT_AUTOMATION_HANDLER_MODULE"]) ??
      "scripts/handlers/playwright-draft-handler.mjs",
    draftPathTemplate: readOption(args, "draft-path-template") ?? "/:platform/drafts",
    healthPath: readOption(args, "health-path") ?? "/health",
    includeCredential: readBoolean(args, "include-credential", ["DRAFT_PLAYWRIGHT_AUTOMATION_INCLUDE_CREDENTIAL"]),
    requireSession: !readBoolean(args, "no-require-session"),
    headless: args.headed ? false : args.headless ? true : undefined,
  };

  const examplePath = path.join(root, ".env.example");
  if (!existsSync(targetEnvFile)) {
    if (!existsSync(examplePath)) {
      throw new Error(`Cannot create ${targetEnvFile}; .env.example is missing.`);
    }

    await mkdir(path.dirname(targetEnvFile), { recursive: true });
    await copyFile(examplePath, targetEnvFile);
  }

  const nextContent = updateEnvContent(await readFile(targetEnvFile, "utf8"), createUpdates(options));
  await writeFile(targetEnvFile, nextContent, "utf8");
  printNextSteps(options, targetEnvFile);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
