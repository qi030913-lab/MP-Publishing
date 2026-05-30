import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const defaultUpdates = new Map([
  ["DRAFT_CONNECTOR_BASE_URL", "http://localhost:3010"],
  ["DRAFT_CONNECTOR_OUTBOX_DIR", ".runtime/drafts"],
  ["ZHIHU_REAL_PUBLISH_ENABLED", "true"],
  ["BILIBILI_REAL_PUBLISH_ENABLED", "true"],
  ["XIAOHONGSHU_REAL_PUBLISH_ENABLED", "true"],
]);

function parseEnvPath() {
  if (process.env.LOCAL_DRAFT_ENV_FILE) {
    return path.resolve(root, process.env.LOCAL_DRAFT_ENV_FILE);
  }

  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === "--target-env-file" || arg.startsWith("--target-env-file="));

  if (index === -1) {
    return path.join(root, ".env");
  }

  const arg = args[index];
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  if (!value) {
    throw new Error("Missing value for --target-env-file.");
  }

  return path.resolve(root, value);
}

function quoteEnvValue(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function updateEnvContent(content) {
  const remaining = new Map(defaultUpdates);
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

    lines.push("# Local draft connector enablement for Zhihu, Bilibili, and Xiaohongshu.");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

const envPath = parseEnvPath();
const examplePath = path.join(root, ".env.example");

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    throw new Error(`Cannot create ${envPath}; .env.example is missing.`);
  }

  await mkdir(path.dirname(envPath), { recursive: true });
  await copyFile(examplePath, envPath);
}

const nextContent = updateEnvContent(await readFile(envPath, "utf8"));
await writeFile(envPath, nextContent, "utf8");

console.log(`Enabled local draft connector publishing in ${path.relative(root, envPath) || ".env"}.`);
console.log("Start api, worker, draft-connector, and web services, then use the publish page to create connector drafts.");
