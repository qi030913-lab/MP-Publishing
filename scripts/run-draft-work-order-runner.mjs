#!/usr/bin/env node

const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

const usageText = `Usage:
  pnpm drafts:run-work-orders -- --sandbox-base-url http://127.0.0.1:3020 --api-key sandbox-secret --once

Options:
  --sandbox-base-url <url>         Defaults to DRAFT_UPSTREAM_SANDBOX_BASE_URL or http://127.0.0.1:3020.
  --api-key <key>                  Optional upstream sandbox bearer token.
  --platform <platforms>           Comma-separated subset: zhihu,bilibili,xiaohongshu.
  --external-base-url <url>        Defaults to DRAFT_WORK_ORDER_EXTERNAL_BASE_URL or https://creator.example.test.
  --external-id-prefix <prefix>    Optional prefix for generated creator-center draft ids.
  --completed-by <value>           Defaults to DRAFT_WORK_ORDER_COMPLETED_BY or draft-work-order-runner.
  --state <state>                  Completion state; defaults to ready.
  --poll-interval-ms <ms>          Continuous mode delay; defaults to 3000.
  --include-completed              Re-run already completed work orders.
  --once                           Run once and print a JSON summary.
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

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

function normalizeState(value) {
  const state = String(value ?? "").trim();
  if (["draft", "publishing", "ready", "succeeded", "failed", "needs_manual_action"].includes(state)) {
    return state;
  }

  throw new Error("--state must be one of draft, publishing, ready, succeeded, failed, needs_manual_action.");
}

function normalizeHttpBaseUrl(value, label) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }

  return url.toString().replace(/\/+$/, "");
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function parsePlatforms(value) {
  if (!value) {
    return Array.from(supportedPlatforms);
  }

  const platforms = value
    .split(",")
    .map((platform) => platform.trim())
    .filter(Boolean);
  const invalid = platforms.filter((platform) => !supportedPlatforms.has(platform));
  if (invalid.length > 0) {
    throw new Error(`Unsupported platform(s): ${invalid.join(", ")}`);
  }

  return platforms;
}

async function requestJson(label, url, { method = "GET", apiKey, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${text || response.statusText}`);
  }

  return payload;
}

async function listWorkOrders({ sandboxBaseUrl, apiKey, platforms }) {
  if (platforms.length === supportedPlatforms.size) {
    const response = await requestJson("List work orders", `${sandboxBaseUrl}/work-orders`, { apiKey });
    return response.items ?? [];
  }

  const results = await Promise.all(
    platforms.map(async (platform) => {
      const response = await requestJson(`List ${platform} work orders`, `${sandboxBaseUrl}/${platform}/work-orders`, { apiKey });
      return response.items ?? [];
    }),
  );
  return results.flat();
}

function createExternalDraftId(workOrder, externalIdPrefix) {
  const base = `${workOrder.platform}-creator-${sanitizeSegment(workOrder.remoteId)}`;
  return externalIdPrefix ? `${sanitizeSegment(externalIdPrefix)}-${base}` : base;
}

function createExternalDraftUrl(externalBaseUrl, platform, externalDraftId) {
  return `${externalBaseUrl}/${platform}/drafts/${externalDraftId}`;
}

async function completeWorkOrder({ sandboxBaseUrl, apiKey, workOrder, externalBaseUrl, externalIdPrefix, completedBy, state }) {
  const detail = await requestJson(
    `Read ${workOrder.platform} work order ${workOrder.remoteId}`,
    `${sandboxBaseUrl}/${workOrder.platform}/work-orders/${workOrder.remoteId}`,
    { apiKey },
  );
  const fullWorkOrder = detail.workOrder;
  if (!fullWorkOrder?.checklist?.some((item) => item.id === "save-draft")) {
    throw new Error(`${workOrder.platform} work order ${workOrder.remoteId} does not include the save-draft checklist item.`);
  }

  const externalDraftId = createExternalDraftId(workOrder, externalIdPrefix);
  const externalUrl = createExternalDraftUrl(externalBaseUrl, workOrder.platform, externalDraftId);
  const completion = await requestJson(
    `Complete ${workOrder.platform} work order ${workOrder.remoteId}`,
    `${sandboxBaseUrl}/${workOrder.platform}/work-orders/${workOrder.remoteId}/complete`,
    {
      method: "POST",
      apiKey,
      body: {
        remoteId: externalDraftId,
        url: externalUrl,
        state,
        completedBy,
        detail: `${workOrder.platform} creator-center draft completed by ${completedBy}.`,
      },
    },
  );

  return {
    platform: workOrder.platform,
    workOrderId: workOrder.remoteId,
    externalDraftId,
    externalUrl,
    state: completion.state,
    callbackStatus: completion.callback?.status,
    callbackOk: completion.callback?.ok,
  };
}

async function runOnce(options) {
  const workOrders = await listWorkOrders(options);
  const pending = workOrders.filter((item) => options.includeCompleted || !item.completed);
  const completed = [];

  for (const workOrder of pending) {
    completed.push(await completeWorkOrder({ ...options, workOrder }));
  }

  return {
    ok: true,
    scannedCount: workOrders.length,
    pendingCount: pending.length,
    completedCount: completed.length,
    skippedCount: workOrders.length - pending.length,
    items: completed,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const options = {
    sandboxBaseUrl: normalizeHttpBaseUrl(
      readOption(args, "sandbox-base-url", ["DRAFT_UPSTREAM_SANDBOX_BASE_URL"]) ?? "http://127.0.0.1:3020",
      "--sandbox-base-url",
    ),
    apiKey: readOption(args, "api-key", ["DRAFT_UPSTREAM_SANDBOX_API_KEY"]),
    platforms: parsePlatforms(readOption(args, "platform", ["DRAFT_WORK_ORDER_PLATFORMS"])),
    externalBaseUrl: normalizeHttpBaseUrl(
      readOption(args, "external-base-url", ["DRAFT_WORK_ORDER_EXTERNAL_BASE_URL"]) ?? "https://creator.example.test",
      "--external-base-url",
    ),
    externalIdPrefix: readOption(args, "external-id-prefix", ["DRAFT_WORK_ORDER_EXTERNAL_ID_PREFIX"]),
    completedBy: readOption(args, "completed-by", ["DRAFT_WORK_ORDER_COMPLETED_BY"]) ?? "draft-work-order-runner",
    state: normalizeState(readOption(args, "state", ["DRAFT_WORK_ORDER_COMPLETION_STATE"]) ?? "ready"),
    pollIntervalMs: parseNonNegativeInteger(readOption(args, "poll-interval-ms", ["DRAFT_WORK_ORDER_POLL_INTERVAL_MS"]) ?? "3000", "--poll-interval-ms"),
    includeCompleted: readBoolean(args, "include-completed", ["DRAFT_WORK_ORDER_INCLUDE_COMPLETED"]),
  };
  const once = readBoolean(args, "once");

  if (once) {
    console.log(JSON.stringify(await runOnce(options), null, 2));
    return;
  }

  while (true) {
    const result = await runOnce(options);
    console.log(JSON.stringify({ ...result, checkedAt: new Date().toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
