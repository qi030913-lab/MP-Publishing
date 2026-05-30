#!/usr/bin/env node

const supportedPlatforms = new Set(["zhihu", "bilibili", "xiaohongshu"]);

const usageText = `Usage:
  pnpm drafts:run-work-orders -- --sandbox-base-url http://127.0.0.1:3020 --api-key sandbox-secret --once

Options:
  --sandbox-base-url <url>         Defaults to DRAFT_UPSTREAM_SANDBOX_BASE_URL or http://127.0.0.1:3020.
  --api-key <key>                  Optional upstream sandbox bearer token.
  --platform <platforms>           Comma-separated subset: zhihu,bilibili,xiaohongshu.
  --automation-endpoint <url>      POST each full work order to this automation/API endpoint before completion.
  --automation-api-key <key>       Optional bearer token for --automation-endpoint.
  --require-automation             Fail if a pending work order has no automation endpoint configured.
  --external-base-url <url>        Defaults to DRAFT_WORK_ORDER_EXTERNAL_BASE_URL or https://creator.example.test.
  --external-id-prefix <prefix>    Optional prefix for generated creator-center draft ids.
  --completed-by <value>           Defaults to DRAFT_WORK_ORDER_COMPLETED_BY or draft-work-order-runner.
  --state <state>                  Completion state; defaults to ready.
  --poll-interval-ms <ms>          Continuous mode delay; defaults to 3000.
  --include-completed              Re-run already completed work orders.
  --once                           Run once and print a JSON summary.
  --help

Environment:
  DRAFT_WORK_ORDER_AUTOMATION_ENDPOINT or DRAFT_WORK_ORDER_<PLATFORM>_AUTOMATION_ENDPOINT
  can point this runner at a real Playwright/official-API worker. Without one, the runner
  keeps using generated creator-center draft links for sandbox rehearsal.`;

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

function normalizeState(value, label = "--state") {
  const state = String(value ?? "").trim();
  if (["draft", "publishing", "ready", "succeeded", "failed", "needs_manual_action"].includes(state)) {
    return state;
  }

  throw new Error(`${label} must be one of draft, publishing, ready, succeeded, failed, needs_manual_action.`);
}

function normalizeHttpBaseUrl(value, label) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }

  return url.toString().replace(/\/+$/, "");
}

function normalizeOptionalHttpUrl(value, label) {
  return value ? normalizeHttpBaseUrl(value, label) : undefined;
}

function readOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function readPlatformAutomationEndpoints(args) {
  const entries = [];
  for (const platform of supportedPlatforms) {
    const optionName = `${platform}-automation-endpoint`;
    const envName = `DRAFT_WORK_ORDER_${platform.toUpperCase()}_AUTOMATION_ENDPOINT`;
    const value = readOption(args, optionName, [envName]);
    if (value) {
      entries.push([platform, normalizeHttpBaseUrl(value, `--${optionName}`)]);
    }
  }

  return new Map(entries);
}

function readPlatformAutomationApiKeys(args) {
  const entries = [];
  for (const platform of supportedPlatforms) {
    const optionName = `${platform}-automation-api-key`;
    const envName = `DRAFT_WORK_ORDER_${platform.toUpperCase()}_AUTOMATION_API_KEY`;
    const value = readOption(args, optionName, [envName]);
    if (value) {
      entries.push([platform, value]);
    }
  }

  return new Map(entries);
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

function resolveAutomationEndpoint(platform, options) {
  return options.platformAutomationEndpoints.get(platform) ?? options.automationEndpoint;
}

function resolveAutomationApiKey(platform, options) {
  return options.platformAutomationApiKeys.get(platform) ?? options.automationApiKey;
}

function createGeneratedDraftResult(workOrder, { externalBaseUrl, externalIdPrefix, completedBy, state }) {
  const externalDraftId = createExternalDraftId(workOrder, externalIdPrefix);
  const externalUrl = createExternalDraftUrl(externalBaseUrl, workOrder.platform, externalDraftId);
  return {
    source: "generated",
    externalDraftId,
    externalUrl,
    state,
    detail: `${workOrder.platform} creator-center draft completed by ${completedBy}.`,
  };
}

async function createAutomationDraftResult(fullWorkOrder, options) {
  const endpoint = resolveAutomationEndpoint(fullWorkOrder.platform, options);
  if (!endpoint) {
    if (options.requireAutomation) {
      throw new Error(
        `${fullWorkOrder.platform} work order ${fullWorkOrder.remoteId} has no automation endpoint. Set --automation-endpoint or DRAFT_WORK_ORDER_${fullWorkOrder.platform.toUpperCase()}_AUTOMATION_ENDPOINT.`,
      );
    }

    return createGeneratedDraftResult(fullWorkOrder, options);
  }

  const payload = await requestJson(`Run ${fullWorkOrder.platform} automation`, endpoint, {
    method: "POST",
    apiKey: resolveAutomationApiKey(fullWorkOrder.platform, options),
    body: {
      platform: fullWorkOrder.platform,
      accountId: fullWorkOrder.accountId,
      workOrder: fullWorkOrder,
      requestedAt: new Date().toISOString(),
      runner: {
        completedBy: options.completedBy,
        safeMode: true,
      },
    },
  });

  if (payload.ok === false) {
    throw new Error(
      `${fullWorkOrder.platform} automation rejected work order ${fullWorkOrder.remoteId}: ${readOptionalString(payload.detail) ?? readOptionalString(payload.message) ?? "no detail"}`,
    );
  }

  const externalDraftId =
    readOptionalString(payload.externalDraftId) ?? readOptionalString(payload.remoteId) ?? readOptionalString(payload.draftId);
  const externalUrl = readOptionalString(payload.externalUrl) ?? readOptionalString(payload.url);
  if (!externalDraftId || !externalUrl) {
    throw new Error(
      `${fullWorkOrder.platform} automation response for ${fullWorkOrder.remoteId} must include remoteId/externalDraftId and url/externalUrl.`,
    );
  }

  return {
    source: "automation",
    automationEndpoint: endpoint,
    externalDraftId,
    externalUrl,
    state: normalizeState(payload.state ?? options.state, "automation response state"),
    detail:
      readOptionalString(payload.detail) ??
      readOptionalString(payload.message) ??
      `${fullWorkOrder.platform} creator-center draft completed by ${options.completedBy}.`,
    issues: Array.isArray(payload.issues) ? payload.issues : [],
  };
}

async function completeWorkOrder(options) {
  const { sandboxBaseUrl, apiKey, workOrder, completedBy } = options;
  const detail = await requestJson(
    `Read ${workOrder.platform} work order ${workOrder.remoteId}`,
    `${sandboxBaseUrl}/${workOrder.platform}/work-orders/${workOrder.remoteId}`,
    { apiKey },
  );
  const fullWorkOrder = detail.workOrder;
  if (!fullWorkOrder?.checklist?.some((item) => item.id === "save-draft")) {
    throw new Error(`${workOrder.platform} work order ${workOrder.remoteId} does not include the save-draft checklist item.`);
  }

  const draftResult = await createAutomationDraftResult(fullWorkOrder, options);
  const completion = await requestJson(
    `Complete ${workOrder.platform} work order ${workOrder.remoteId}`,
    `${sandboxBaseUrl}/${workOrder.platform}/work-orders/${workOrder.remoteId}/complete`,
    {
      method: "POST",
      apiKey,
      body: {
        remoteId: draftResult.externalDraftId,
        url: draftResult.externalUrl,
        state: draftResult.state,
        completedBy,
        detail: draftResult.detail,
        ...(draftResult.issues?.length ? { issues: draftResult.issues } : {}),
      },
    },
  );

  return {
    platform: workOrder.platform,
    workOrderId: workOrder.remoteId,
    source: draftResult.source,
    ...(draftResult.automationEndpoint ? { automationEndpoint: draftResult.automationEndpoint } : {}),
    externalDraftId: draftResult.externalDraftId,
    externalUrl: draftResult.externalUrl,
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
    automationEndpoint: normalizeOptionalHttpUrl(
      readOption(args, "automation-endpoint", ["DRAFT_WORK_ORDER_AUTOMATION_ENDPOINT"]),
      "--automation-endpoint",
    ),
    platformAutomationEndpoints: readPlatformAutomationEndpoints(args),
    automationApiKey: readOption(args, "automation-api-key", ["DRAFT_WORK_ORDER_AUTOMATION_API_KEY"]),
    platformAutomationApiKeys: readPlatformAutomationApiKeys(args),
    requireAutomation: readBoolean(args, "require-automation", ["DRAFT_WORK_ORDER_REQUIRE_AUTOMATION"]),
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
