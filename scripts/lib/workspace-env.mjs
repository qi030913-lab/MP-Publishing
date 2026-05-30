import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function findWorkspaceRoot(startDir = process.cwd()) {
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

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseEnvFileContent(content) {
  const values = new Map();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    values.set(match[1], unquoteEnvValue(match[2]));
  }

  return values;
}

export function loadWorkspaceEnv({
  root = findWorkspaceRoot(process.cwd()),
  envPath,
  override = false,
} = {}) {
  const targetEnvPath =
    (typeof envPath === "string" && envPath.trim()) ||
    process.env.DRAFT_AUTOMATION_ENV_FILE?.trim() ||
    process.env.WORKSPACE_ENV_FILE?.trim() ||
    ".env";
  const resolvedEnvPath = path.isAbsolute(targetEnvPath) ? path.resolve(targetEnvPath) : path.resolve(root, targetEnvPath);
  if (!existsSync(resolvedEnvPath)) {
    return { loaded: false, envPath: resolvedEnvPath, keys: [] };
  }

  const values = parseEnvFileContent(readFileSync(resolvedEnvPath, "utf8"));
  const applied = [];

  for (const [key, value] of values) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }

  return { loaded: true, envPath: resolvedEnvPath, keys: applied };
}
