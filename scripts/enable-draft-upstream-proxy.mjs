#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platforms = ["zhihu", "bilibili", "xiaohongshu"];
const platformLabels = new Map([
  ["zhihu", "Zhihu"],
  ["bilibili", "Bilibili"],
  ["xiaohongshu", "Xiaohongshu"],
]);

const usageText = `Usage:
  pnpm drafts:enable-upstream -- --proxy-base-url https://proxy.example.com --api-key "$PROXY_API_KEY" --check

Options:
  --target-env-file <path>         Defaults to .env, or DRAFT_UPSTREAM_ENV_FILE.
  --proxy-base-url <url>           Required base URL for the upstream proxy.
  --connector-base-url <url>       Defaults to LOCAL_DRAFT_CONNECTOR_BASE_URL or http://localhost:3010.
  --public-base-url <url>          Optional DRAFT_CONNECTOR_PUBLIC_BASE_URL.
  --outbox-dir <path>              Defaults to LOCAL_DRAFT_OUTBOX_DIR or .runtime/drafts.
  --platforms <list>               Comma-separated subset; defaults to zhihu,bilibili,xiaohongshu.
  --draft-path-template <path>     Defaults to /:platform/drafts.
  --status-path-template <path>    Defaults to /:platform/status.
  --health-path <path>             Defaults to /health.
  --no-status                      Clear per-platform upstream status endpoints.
  --no-health                      Clear per-platform upstream health endpoints.
  --api-key <key>                  Sets DRAFT_CONNECTOR_UPSTREAM_API_KEY.
  --status-api-key <key>           Sets DRAFT_CONNECTOR_UPSTREAM_STATUS_API_KEY; defaults to --api-key for --check only.
  --include-credential             Enables both adapter and connector draft credential forwarding flags.
  --status-include-credential      Enables both adapter and connector status credential forwarding flags.
  --check                          Run the upstream contract checker for each selected platform after writing .env.
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

function createUpdates(options) {
  const updates = new Map([
    ["DRAFT_CONNECTOR_BASE_URL", options.connectorBaseUrl],
    ["DRAFT_CONNECTOR_OUTBOX_DIR", options.outboxDir],
  ]);

  if (options.publicBaseUrl) {
    updates.set("DRAFT_CONNECTOR_PUBLIC_BASE_URL", options.publicBaseUrl);
  }

  if (options.apiKey !== undefined) {
    updates.set("DRAFT_CONNECTOR_UPSTREAM_API_KEY", options.apiKey);
  }

  if (options.statusApiKey !== undefined) {
    updates.set("DRAFT_CONNECTOR_UPSTREAM_STATUS_API_KEY", options.statusApiKey);
  }

  for (const platform of options.platforms) {
    const envPrefix = platform.toUpperCase();
    const upstreamPrefix = `DRAFT_CONNECTOR_${envPrefix}_UPSTREAM`;
    updates.set(`${envPrefix}_REAL_PUBLISH_ENABLED`, "true");
    updates.set(`${envPrefix}_DRAFT_INCLUDE_CREDENTIAL`, formatBoolean(options.includeCredential));
    updates.set(`${envPrefix}_STATUS_INCLUDE_CREDENTIAL`, formatBoolean(options.withStatus && options.statusIncludeCredential));
    updates.set(`${upstreamPrefix}_DRAFT_ENDPOINT`, joinUrl(options.proxyBaseUrl, options.draftPathTemplate, platform));
    updates.set(`${upstreamPrefix}_STATUS_ENDPOINT`, options.withStatus ? joinUrl(options.proxyBaseUrl, options.statusPathTemplate, platform) : "");
    updates.set(`${upstreamPrefix}_HEALTH_ENDPOINT`, options.withHealth ? joinUrl(options.proxyBaseUrl, options.healthPath, platform) : "");
    updates.set(`${upstreamPrefix}_INCLUDE_CREDENTIAL`, formatBoolean(options.includeCredential));
    updates.set(`${upstreamPrefix}_STATUS_INCLUDE_CREDENTIAL`, formatBoolean(options.withStatus && options.statusIncludeCredential));
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

    lines.push("# Upstream draft proxy enablement for Zhihu, Bilibili, and Xiaohongshu.");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

async function runChecker(options) {
  const checkerPath = path.join(root, "scripts/check-draft-upstream-contract.mjs");

  for (const platform of options.platforms) {
    const args = [
      checkerPath,
      "--platform",
      platform,
      "--draft-endpoint",
      joinUrl(options.proxyBaseUrl, options.draftPathTemplate, platform),
    ];

    if (options.withStatus) {
      args.push("--status-endpoint", joinUrl(options.proxyBaseUrl, options.statusPathTemplate, platform));
    }

    if (options.withHealth) {
      args.push("--health-endpoint", joinUrl(options.proxyBaseUrl, options.healthPath, platform));
    }

    if (options.apiKey) {
      args.push("--api-key", options.apiKey);
    }

    if (options.statusApiKey) {
      args.push("--status-api-key", options.statusApiKey);
    }

    if (options.includeCredential) {
      args.push("--include-credential");
    }

    if (options.statusIncludeCredential) {
      args.push("--status-include-credential");
    }

    console.log(`\nChecking ${platformLabels.get(platform)} upstream proxy contract...`);
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    const [code] = await once(child, "exit");
    if (code !== 0) {
      throw new Error(`${platform} upstream proxy contract check failed with exit code ${code}.`);
    }
  }
}

function printNextSteps(options, envPath) {
  console.log(`Enabled upstream draft proxy settings in ${path.relative(root, envPath) || ".env"}.`);
  console.log(`Platforms: ${options.platforms.join(", ")}`);

  if (options.check) {
    console.log("Upstream proxy contract checks passed.");
    return;
  }

  console.log("Verify each upstream proxy before starting the connector. Example:");
  const platform = options.platforms[0];
  const args = [
    "pnpm drafts:check-upstream --",
    `--platform ${platform}`,
    `--draft-endpoint ${joinUrl(options.proxyBaseUrl, options.draftPathTemplate, platform)}`,
  ];
  if (options.withStatus) {
    args.push(`--status-endpoint ${joinUrl(options.proxyBaseUrl, options.statusPathTemplate, platform)}`);
  }
  if (options.withHealth) {
    args.push(`--health-endpoint ${joinUrl(options.proxyBaseUrl, options.healthPath, platform)}`);
  }
  if (options.apiKey) {
    args.push("--api-key \"$PROXY_API_KEY\"");
  }
  console.log(args.join(" "));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const proxyBaseUrl = requireHttpUrl(readOption(args, "proxy-base-url", ["DRAFT_UPSTREAM_PROXY_BASE_URL"]), "--proxy-base-url");
  const connectorBaseUrl = requireHttpUrl(
    readOption(args, "connector-base-url", ["LOCAL_DRAFT_CONNECTOR_BASE_URL"]) ?? "http://localhost:3010",
    "--connector-base-url",
  );
  const publicBaseUrl = optionalHttpUrl(readOption(args, "public-base-url", ["LOCAL_DRAFT_CONNECTOR_PUBLIC_BASE_URL"]), "--public-base-url");
  const targetEnvFile = path.resolve(root, readOption(args, "target-env-file", ["DRAFT_UPSTREAM_ENV_FILE"]) ?? ".env");
  const options = {
    proxyBaseUrl,
    connectorBaseUrl,
    publicBaseUrl,
    outboxDir: readOption(args, "outbox-dir", ["LOCAL_DRAFT_OUTBOX_DIR"]) ?? ".runtime/drafts",
    platforms: parsePlatforms(readOption(args, "platforms")),
    draftPathTemplate: readOption(args, "draft-path-template") ?? "/:platform/drafts",
    statusPathTemplate: readOption(args, "status-path-template") ?? "/:platform/status",
    healthPath: readOption(args, "health-path") ?? "/health",
    withStatus: !readBoolean(args, "no-status"),
    withHealth: !readBoolean(args, "no-health"),
    apiKey: readOption(args, "api-key", ["DRAFT_UPSTREAM_PROXY_API_KEY"]),
    statusApiKey: readOption(args, "status-api-key", ["DRAFT_UPSTREAM_PROXY_STATUS_API_KEY"]),
    includeCredential: readBoolean(args, "include-credential", ["DRAFT_UPSTREAM_PROXY_INCLUDE_CREDENTIAL"]),
    statusIncludeCredential: readBoolean(args, "status-include-credential", ["DRAFT_UPSTREAM_PROXY_STATUS_INCLUDE_CREDENTIAL"]),
    check: readBoolean(args, "check"),
  };

  const examplePath = path.join(root, ".env.example");
  if (!existsSync(targetEnvFile)) {
    if (!existsSync(examplePath)) {
      throw new Error(`Cannot create ${targetEnvFile}; .env.example is missing.`);
    }

    await mkdir(path.dirname(targetEnvFile), { recursive: true });
    await copyFile(examplePath, targetEnvFile);
  }

  const updates = createUpdates(options);
  const nextContent = updateEnvContent(await readFile(targetEnvFile, "utf8"), updates);
  await writeFile(targetEnvFile, nextContent, "utf8");

  if (options.check) {
    await runChecker({
      ...options,
      statusApiKey: options.statusApiKey ?? options.apiKey,
    });
  }

  printNextSteps(options, targetEnvFile);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
