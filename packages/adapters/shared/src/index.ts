import type { CanonicalDocument } from "@mp-publishing/content-model";
import type {
  AdaptOptions,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformDraft,
  PlatformName,
  PublishInput,
  PublishResult,
  PublishStatus,
  PublishStatusInput,
  SimulationResult,
  ValidationIssue,
} from "@mp-publishing/platform-sdk";

declare const process: {
  env: Record<string, string | undefined>;
};

type AdapterPreset = {
  platform: PlatformName;
  capabilities: PlatformCapabilities;
  titleSuffix?: string;
  intro?: string;
  bulletsStyle?: "dash" | "number";
  extraHashtags?: string[];
  realDraft?: {
    envPrefix: string;
    remoteIdPrefix: string;
    urlScheme: string;
  };
};

function extractBodySegments(document: CanonicalDocument, bulletStyle: AdapterPreset["bulletsStyle"]): string[] {
  return document.blocks.flatMap((block) => {
    if (block.text) {
      return [block.text];
    }

    if (block.items) {
      return block.items.map((item, index) =>
        bulletStyle === "number" ? `${index + 1}. ${item}` : `- ${item}`,
      );
    }

    return [];
  });
}

function createTitle(document: CanonicalDocument, capabilities: PlatformCapabilities, suffix?: string): string {
  const baseTitle = suffix ? `${document.title}${suffix}` : document.title;
  const titleMaxLength = capabilities.titleMaxLength;

  if (!titleMaxLength || baseTitle.length <= titleMaxLength) {
    return baseTitle;
  }

  return `${baseTitle.slice(0, Math.max(titleMaxLength - 3, 1))}...`;
}

function createIssue(code: string, message: string, severity: ValidationIssue["severity"] = "error"): ValidationIssue {
  return {
    code,
    message,
    severity,
  };
}

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isEnabled(key: string) {
  return readEnvValue(key)?.toLowerCase() === "true";
}

function createDraftEnvKey(prefix: string, suffix: string) {
  return `${prefix}_${suffix}`;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveConnectorEndpoint(config: NonNullable<AdapterPreset["realDraft"]>, platform: PlatformName, operation: "drafts" | "status") {
  const key = createDraftEnvKey(config.envPrefix, operation === "drafts" ? "DRAFT_ENDPOINT" : "STATUS_ENDPOINT");
  const explicitEndpoint = readEnvValue(key);
  if (explicitEndpoint) {
    return explicitEndpoint;
  }

  const baseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL");
  return baseUrl ? `${trimTrailingSlash(baseUrl)}/${platform}/${operation}` : undefined;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.text();
  const payload = body ? (JSON.parse(body) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(`Draft connector HTTP ${response.status}: ${body || response.statusText}`);
  }

  return payload;
}

type DraftConnectorResponse = {
  ok?: boolean;
  draftId?: string;
  remoteId?: string;
  url?: string;
  message?: string;
  issues?: ValidationIssue[];
};

type StatusConnectorResponse = {
  state?: PublishStatus["state"];
  detail?: string;
  remoteId?: string;
  url?: string;
  issues?: ValidationIssue[];
};

function createConnectorDraftPayload(input: PublishInput, draft: PlatformDraft, includeCredential: boolean) {
  return {
    platform: draft.platform,
    accountId: input.accountId,
    document: input.document,
    draft,
    credential: includeCredential ? input.credential : undefined,
    requestedAt: new Date().toISOString(),
  };
}

async function publishDraftThroughConnector(
  preset: AdapterPreset,
  input: PublishInput,
  draft: PlatformDraft,
  issues: ValidationIssue[],
): Promise<PublishResult> {
  const config = preset.realDraft;
  if (!config) {
    return {
      ok: false,
      issues: [...issues, createIssue(`${preset.platform.toUpperCase()}_REAL_DRAFT_UNSUPPORTED`, "Real draft publishing is not configured for this adapter.")],
    };
  }

  const enabledKey = createDraftEnvKey(config.envPrefix, "REAL_PUBLISH_ENABLED");
  if (!isEnabled(enabledKey)) {
    return {
      ok: false,
      issues: [
        ...issues,
        createIssue(
          `${preset.platform.toUpperCase()}_REAL_PUBLISH_DISABLED`,
          `Set ${enabledKey}=true before allowing this adapter to call its draft connector.`,
        ),
      ],
    };
  }

  const endpoint = resolveConnectorEndpoint(config, preset.platform, "drafts");
  if (!endpoint) {
    const endpointKey = createDraftEnvKey(config.envPrefix, "DRAFT_ENDPOINT");
    return {
      ok: false,
      issues: [
        ...issues,
        createIssue(
          `${preset.platform.toUpperCase()}_DRAFT_ENDPOINT_MISSING`,
          `${endpointKey} is required before creating a real ${preset.platform} draft.`,
        ),
      ],
    };
  }

  const apiKey = readEnvValue(createDraftEnvKey(config.envPrefix, "DRAFT_API_KEY")) ?? readEnvValue("DRAFT_CONNECTOR_API_KEY");
  const includeCredential = isEnabled(createDraftEnvKey(config.envPrefix, "DRAFT_INCLUDE_CREDENTIAL"));

  try {
    const payload = await requestJson<DraftConnectorResponse>(endpoint, {
      method: "POST",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      body: JSON.stringify(createConnectorDraftPayload(input, draft, includeCredential)),
    });

    if (payload.ok === false) {
      const remoteId = payload.remoteId ?? payload.draftId;
      return {
        ok: false,
        remoteId,
        url: payload.url ?? (remoteId ? `${config.urlScheme}://draft/${remoteId}` : undefined),
        issues: [
          ...issues,
          ...(payload.issues ?? []),
          createIssue(
            `${preset.platform.toUpperCase()}_DRAFT_CONNECTOR_REJECTED`,
            payload.message ?? `${preset.platform} draft connector rejected the draft.`,
          ),
        ],
      };
    }

    const remoteId = payload.remoteId ?? payload.draftId ?? `${config.remoteIdPrefix}-${Date.now()}`;
    return {
      ok: true,
      remoteId,
      url: payload.url ?? `${config.urlScheme}://draft/${remoteId}`,
      issues: [
        ...issues,
        ...(payload.issues ?? []),
        createIssue(
          `${preset.platform.toUpperCase()}_DRAFT_CREATED`,
          payload.message ?? `${preset.platform} draft connector accepted the draft.`,
          "info",
        ),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      issues: [
        ...issues,
        createIssue(
          `${preset.platform.toUpperCase()}_DRAFT_CONNECTOR_ERROR`,
          error instanceof Error ? error.message : `Unknown ${preset.platform} draft connector error.`,
        ),
      ],
    };
  }
}

async function queryDraftConnectorStatus(
  preset: AdapterPreset,
  remoteId: string,
  input?: PublishStatusInput,
): Promise<PublishStatus> {
  const config = preset.realDraft;
  if (!config) {
    return {
      state: "needs_manual_action",
      detail: `${preset.platform} does not expose a remote status connector.`,
      remoteId,
    };
  }

  const endpoint = resolveConnectorEndpoint(config, preset.platform, "status");
  if (!endpoint) {
    return {
      state: "draft",
      detail: `${preset.platform} draft was created; no status connector is configured.`,
      remoteId,
    };
  }

  const apiKey =
    readEnvValue(createDraftEnvKey(config.envPrefix, "STATUS_API_KEY")) ??
    readEnvValue(createDraftEnvKey(config.envPrefix, "DRAFT_API_KEY")) ??
    readEnvValue("DRAFT_CONNECTOR_API_KEY");
  const includeCredential = isEnabled(createDraftEnvKey(config.envPrefix, "STATUS_INCLUDE_CREDENTIAL"));

  try {
    const payload = await requestJson<StatusConnectorResponse>(endpoint, {
      method: "POST",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      body: JSON.stringify({
        platform: preset.platform,
        accountId: input?.accountId,
        remoteId,
        credential: includeCredential ? input?.credential : undefined,
        requestedAt: new Date().toISOString(),
      }),
    });

    return {
      state: payload.state ?? "draft",
      detail: payload.detail ?? `${preset.platform} status connector returned ${payload.state ?? "draft"}.`,
      remoteId: payload.remoteId ?? remoteId,
      url: payload.url,
      issues: payload.issues,
    };
  } catch (error) {
    return {
      state: "needs_manual_action",
      detail: error instanceof Error ? error.message : `Unknown ${preset.platform} status connector error.`,
      remoteId,
      issues: [
        createIssue(
          `${preset.platform.toUpperCase()}_STATUS_CONNECTOR_FAILED`,
          error instanceof Error ? error.message : `Unknown ${preset.platform} status connector error.`,
          "warning",
        ),
      ],
    };
  }
}

export function createAdapter(preset: AdapterPreset): PlatformAdapter {
  return {
    platform: preset.platform,
    getCapabilities() {
      return preset.capabilities;
    },
    async validate(document) {
      const issues: ValidationIssue[] = [];

      if (
        preset.capabilities.titleMaxLength &&
        document.title.length > preset.capabilities.titleMaxLength
      ) {
        issues.push({
          code: "TITLE_TOO_LONG",
          message: `Title exceeds ${preset.platform} recommendation length.`,
          severity: "warning",
        });
      }

      if (document.assets.length === 0) {
        issues.push({
          code: "MISSING_VISUAL_ASSET",
          message: `${preset.platform} preview currently has no visual asset attached.`,
          severity: "info",
        });
      }

      if (!document.summary) {
        issues.push({
          code: "MISSING_SUMMARY",
          message: `${preset.platform} preview is using an auto-generated lead paragraph because summary is empty.`,
          severity: "info",
        });
      }

      return issues;
    },
    async adapt(document: CanonicalDocument, options: AdaptOptions): Promise<PlatformDraft> {
      const warnings = await this.validate(document);
      const segments = extractBodySegments(document, preset.bulletsStyle ?? "dash");
      const intro = document.summary ?? preset.intro ?? "基于统一内容模型生成的平台预览。";
      const body = [intro, ...segments].join("\n\n");
      const hashtags = [
        ...document.metadata.topics.map((topic) => `#${topic}`),
        ...(preset.extraHashtags ?? []),
      ];

      return {
        platform: preset.platform,
        title: options.preserveOriginal
          ? document.title
          : createTitle(document, preset.capabilities, preset.titleSuffix),
        summary: intro,
        body,
        hashtags,
        warnings,
      };
    },
    async simulatePublish(input: PublishInput): Promise<SimulationResult> {
      const issues = await this.validate(input.document);
      const config = preset.realDraft;

      if (config && !isEnabled(createDraftEnvKey(config.envPrefix, "REAL_PUBLISH_ENABLED"))) {
        issues.push(
          createIssue(
            `${preset.platform.toUpperCase()}_REAL_PUBLISH_DISABLED`,
            `${preset.platform} real draft connector is disabled.`,
            "warning",
          ),
        );
      }

      if (config && !resolveConnectorEndpoint(config, preset.platform, "drafts")) {
        issues.push(
          createIssue(
            `${preset.platform.toUpperCase()}_DRAFT_ENDPOINT_MISSING`,
            `${preset.platform} draft connector endpoint is not configured.`,
            "warning",
          ),
        );
      }

      return {
        ok: issues.every((issue) => issue.severity !== "error"),
        screenshots: [`simulation://${preset.platform}/compose`],
        issues,
      };
    },
    async publish(input: PublishInput): Promise<PublishResult> {
      const issues = await this.validate(input.document);

      if (!input.dryRun) {
        const draft = await this.adapt(input.document, {
          toneMode: "platform-optimized",
          preserveOriginal: false,
        });

        return publishDraftThroughConnector(preset, input, draft, issues);
      }

      return {
        ok: true,
        remoteId: `dry-run-${preset.platform}`,
        url: `https://example.com/published/${preset.platform}`,
        issues,
      };
    },
    async getPublishStatus(remoteId: string, input?: PublishStatusInput) {
      return queryDraftConnectorStatus(preset, remoteId, input);
    },
  };
}
