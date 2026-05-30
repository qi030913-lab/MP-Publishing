#!/usr/bin/env node

const CONTRACT_VERSION = "draft-connector-upstream-v1";
const SUPPORTED_PLATFORMS = new Set(["zhihu", "bilibili", "xiaohongshu"]);
const SUPPORTED_STATES = new Set(["draft", "publishing", "ready", "succeeded", "failed", "needs_manual_action"]);

const usageText = `Usage:
  pnpm drafts:check-upstream -- --platform zhihu --draft-endpoint https://proxy.example.com/zhihu/drafts

Options:
  --platform <zhihu|bilibili|xiaohongshu>
  --draft-endpoint <url>           Required upstream draft endpoint.
  --status-endpoint <url>          Optional upstream status endpoint.
  --health-endpoint <url>          Optional upstream health endpoint.
  --api-key <key>                  Bearer token for health and draft checks.
  --status-api-key <key>           Bearer token for status checks; defaults to --api-key.
  --account-id <id>                Synthetic account id; defaults to contract-check-<platform>.
  --callback-base-url <url>        Connector callback base; defaults to https://connector.example.test.
  --include-credential             Include a synthetic draft credential payload.
  --status-include-credential      Include a synthetic status credential payload.
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
    return url.toString();
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

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function jsonHeaders(apiKey, hasBody = true) {
  return {
    accept: "application/json",
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function requestJson(label, url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`${label} request failed before receiving a response: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rawBody = await response.text();
  let body = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      throw new Error(`${label} returned non-JSON response ${response.status}: ${rawBody.slice(0, 300)}`);
    }
  }

  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}: ${JSON.stringify(body)}`);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${label} returned a JSON value that is not an object: ${JSON.stringify(body)}`);
  }

  return { status: response.status, body };
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractRemoteId(payload) {
  return asString(payload.remoteId) ?? asString(payload.externalDraftId) ?? asString(payload.draftId);
}

function extractUrl(payload) {
  return asString(payload.url) ?? asString(payload.externalUrl);
}

function validateDraftResponse(payload) {
  if (payload.ok === false) {
    throw new Error(`Draft endpoint rejected the synthetic draft: ${payload.message ?? payload.detail ?? JSON.stringify(payload)}`);
  }

  const state = asString(payload.state);
  if (state && !SUPPORTED_STATES.has(state)) {
    throw new Error(`Draft endpoint returned unsupported state "${state}".`);
  }

  const remoteId = extractRemoteId(payload);
  const url = extractUrl(payload);
  if (!remoteId && !url) {
    throw new Error("Draft endpoint must return at least one of remoteId, externalDraftId, draftId, url, or externalUrl.");
  }

  return {
    ok: payload.ok ?? true,
    state: state ?? null,
    remoteId: remoteId ?? null,
    url: url ?? null,
    detail: asString(payload.detail) ?? asString(payload.message) ?? null,
  };
}

function validateStatusResponse(payload) {
  if (payload.ok === false) {
    throw new Error(`Status endpoint rejected the synthetic status query: ${payload.message ?? payload.detail ?? JSON.stringify(payload)}`);
  }

  const state = asString(payload.state);
  if (!state) {
    throw new Error("Status endpoint must return a draft state.");
  }

  if (!SUPPORTED_STATES.has(state)) {
    throw new Error(`Status endpoint returned unsupported state "${state}".`);
  }

  return {
    ok: payload.ok ?? true,
    state,
    remoteId: extractRemoteId(payload) ?? null,
    url: extractUrl(payload) ?? null,
    detail: asString(payload.detail) ?? asString(payload.message) ?? null,
  };
}

function createCredential(platform, accountId, draftId) {
  return {
    platform,
    accountId,
    authMode: "token",
    credentialRef: `contract-check-${platform}`,
    accessToken: `contract-check-token-${draftId}`,
    cookies: `contract_check_session=${draftId}`,
    storageStateJson: JSON.stringify({ cookies: [], origins: [] }),
  };
}

function createDraftPayload({ platform, accountId, callbackBaseUrl, includeCredential }) {
  const checkedAt = new Date().toISOString();
  const draftId = `${platform}-contract-check-${Date.now().toString(36)}`;
  const payload = {
    platform,
    accountId,
    document: {
      id: `contract-check-document-${draftId}`,
      title: "Draft upstream contract check",
      summary: `Synthetic ${platform} payload for validating the local draft connector upstream contract.`,
      source: "scripts/check-draft-upstream-contract.mjs",
      blocks: [
        {
          type: "paragraph",
          text: "This payload verifies that an upstream proxy can accept draft requests from the local draft connector.",
        },
      ],
    },
    draft: {
      platform,
      title: `Draft upstream contract check ${checkedAt}`,
      summary: "Synthetic draft used by the MP Publishing upstream contract checker.",
      body: "This is a synthetic non-production draft payload. It should be accepted by a sandbox or test account before enabling real publishing.",
      hashtags: ["draft", "contract", platform],
      warnings: [],
    },
    execution: {
      taskId: `contract-check-task-${draftId}`,
      targetId: `contract-check-target-${draftId}`,
      attemptCount: 1,
    },
    requestedAt: checkedAt,
    connector: {
      draftId,
      draftUrl: `${callbackBaseUrl}/${platform}/drafts/${draftId}`,
      statusCallbackUrl: `${callbackBaseUrl}/${platform}/drafts/${draftId}/status`,
    },
  };

  if (includeCredential) {
    payload.credential = createCredential(platform, accountId, draftId);
  }

  return payload;
}

function createStatusPayload({ platform, accountId, callbackBaseUrl, connectorDraftId, remoteId, includeCredential }) {
  const payload = {
    platform,
    accountId,
    remoteId,
    requestedAt: new Date().toISOString(),
    connector: {
      draftId: connectorDraftId,
      draftUrl: `${callbackBaseUrl}/${platform}/drafts/${connectorDraftId}`,
      statusCallbackUrl: `${callbackBaseUrl}/${platform}/drafts/${connectorDraftId}/status`,
    },
  };

  if (includeCredential) {
    payload.credential = createCredential(platform, accountId, connectorDraftId);
  }

  return payload;
}

function platformEnv(platform, suffix) {
  return `DRAFT_CONNECTOR_${platform.toUpperCase()}_${suffix}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText);
    return;
  }

  const platform = readOption(args, "platform", ["DRAFT_UPSTREAM_PLATFORM"]);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    failUsage("--platform must be one of zhihu, bilibili, or xiaohongshu.");
  }

  const draftEndpoint = requireHttpUrl(
    readOption(args, "draft-endpoint", ["DRAFT_UPSTREAM_DRAFT_ENDPOINT", platformEnv(platform, "UPSTREAM_DRAFT_ENDPOINT")]),
    "--draft-endpoint",
  );
  const statusEndpoint = optionalHttpUrl(
    readOption(args, "status-endpoint", ["DRAFT_UPSTREAM_STATUS_ENDPOINT", platformEnv(platform, "UPSTREAM_STATUS_ENDPOINT")]),
    "--status-endpoint",
  );
  const healthEndpoint = optionalHttpUrl(
    readOption(args, "health-endpoint", [
      "DRAFT_UPSTREAM_HEALTH_ENDPOINT",
      platformEnv(platform, "UPSTREAM_HEALTH_ENDPOINT"),
      "DRAFT_CONNECTOR_UPSTREAM_HEALTH_ENDPOINT",
    ]),
    "--health-endpoint",
  );
  const apiKey = readOption(args, "api-key", [
    "DRAFT_UPSTREAM_API_KEY",
    platformEnv(platform, "UPSTREAM_DRAFT_API_KEY"),
    "DRAFT_CONNECTOR_UPSTREAM_API_KEY",
  ]);
  const statusApiKey =
    readOption(args, "status-api-key", [
      "DRAFT_UPSTREAM_STATUS_API_KEY",
      platformEnv(platform, "UPSTREAM_STATUS_API_KEY"),
      "DRAFT_CONNECTOR_UPSTREAM_STATUS_API_KEY",
    ]) ?? apiKey;
  const accountId = readOption(args, "account-id", ["DRAFT_UPSTREAM_ACCOUNT_ID"]) ?? `contract-check-${platform}`;
  const callbackBaseUrl = stripTrailingSlash(
    requireHttpUrl(readOption(args, "callback-base-url", ["DRAFT_UPSTREAM_CALLBACK_BASE_URL"]) ?? "https://connector.example.test", "--callback-base-url"),
  );
  const includeCredential = readBoolean(args, "include-credential", ["DRAFT_UPSTREAM_INCLUDE_CREDENTIAL"]);
  const statusIncludeCredential = readBoolean(args, "status-include-credential", ["DRAFT_UPSTREAM_STATUS_INCLUDE_CREDENTIAL"]);

  const health = healthEndpoint
    ? await requestJson("Health endpoint", healthEndpoint, {
        method: "GET",
        headers: jsonHeaders(apiKey, false),
      }).then(({ status, body }) => ({
        endpoint: healthEndpoint,
        status,
        ok: body.ok ?? true,
        detail: asString(body.detail) ?? asString(body.message) ?? null,
      }))
    : null;

  if (health?.ok === false) {
    throw new Error(`Health endpoint reported ok=false: ${JSON.stringify(health)}`);
  }

  const draftPayload = createDraftPayload({ platform, accountId, callbackBaseUrl, includeCredential });
  const draft = await requestJson("Draft endpoint", draftEndpoint, {
    method: "POST",
    headers: jsonHeaders(apiKey),
    body: JSON.stringify(draftPayload),
  }).then(({ body }) => validateDraftResponse(body));

  let status = null;
  if (statusEndpoint) {
    const remoteId = draft.remoteId;
    if (!remoteId) {
      throw new Error("Status endpoint was provided, but draft response did not include a remoteId, externalDraftId, or draftId.");
    }

    const statusPayload = createStatusPayload({
      platform,
      accountId,
      callbackBaseUrl,
      connectorDraftId: draftPayload.connector.draftId,
      remoteId,
      includeCredential: statusIncludeCredential,
    });
    status = await requestJson("Status endpoint", statusEndpoint, {
      method: "POST",
      headers: jsonHeaders(statusApiKey),
      body: JSON.stringify(statusPayload),
    }).then(({ body }) => validateStatusResponse(body));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        version: CONTRACT_VERSION,
        platform,
        checkedAt: new Date().toISOString(),
        endpoints: {
          draft: draftEndpoint,
          status: statusEndpoint ?? null,
          health: healthEndpoint ?? null,
        },
        credentialForwarding: {
          draft: includeCredential,
          status: statusIncludeCredential,
        },
        connector: {
          draftId: draftPayload.connector.draftId,
          draftUrl: draftPayload.connector.draftUrl,
          statusCallbackUrl: draftPayload.connector.statusCallbackUrl,
        },
        health,
        draft,
        status,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
