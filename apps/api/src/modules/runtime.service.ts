import { Injectable } from "@nestjs/common";
import { getRuntimeStats } from "@mp-publishing/task-runtime";
import type { PlatformName } from "@mp-publishing/platform-sdk";

type DraftConnectorStatus = "online" | "offline" | "configured" | "unconfigured";

type DraftConnectorPlatformStatus = {
  platform: PlatformName;
  realPublishEnabled: boolean;
  draftEndpoint?: string;
  statusEndpoint?: string;
  upstreamDraftEndpointConfigured?: boolean;
  upstreamStatusEndpointConfigured?: boolean;
  upstreamCredentialForwardingEnabled?: boolean;
  upstreamStatusCredentialForwardingEnabled?: boolean;
  upstreamDraftStatus?: "unconfigured" | "configured" | "online" | "offline";
  upstreamDraftDetail?: string;
  upstreamDraftHealthEndpoint?: string;
};

type DraftConnectorHealthPayload = {
  status?: string;
  outboxDir?: string;
  upstreamDrafts?: Array<{
    platform?: PlatformName;
    draftEndpointConfigured?: boolean;
    statusEndpointConfigured?: boolean;
    credentialForwardingEnabled?: boolean;
    statusCredentialForwardingEnabled?: boolean;
    healthEndpoint?: string;
    status?: "unconfigured" | "configured" | "online" | "offline";
    detail?: string;
  }>;
};

const draftConnectorPlatforms: Array<{ platform: PlatformName; envPrefix: string }> = [
  { platform: "zhihu", envPrefix: "ZHIHU" },
  { platform: "bilibili", envPrefix: "BILIBILI" },
  { platform: "xiaohongshu", envPrefix: "XIAOHONGSHU" },
];

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isEnabled(key: string) {
  return readEnvValue(key)?.toLowerCase() === "true";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isLocalConnectorHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function inferLocalDraftConnectorHealthUrl(platform: PlatformName, draftEndpoint: string | undefined) {
  if (!draftEndpoint) {
    return undefined;
  }

  try {
    const url = new URL(draftEndpoint);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!isLocalConnectorHost(url.hostname) || pathname !== `/${platform}/drafts`) {
      return undefined;
    }

    return `${url.origin}/health`;
  } catch {
    return undefined;
  }
}

function inferLocalConnectorEndpointFromDraftEndpoint(
  platform: PlatformName,
  draftEndpoint: string | undefined,
  operation: "status",
) {
  if (!draftEndpoint) {
    return undefined;
  }

  try {
    const url = new URL(draftEndpoint);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!isLocalConnectorHost(url.hostname) || pathname !== `/${platform}/drafts`) {
      return undefined;
    }

    return `${url.origin}/${platform}/${operation}`;
  } catch {
    return undefined;
  }
}

function resolveConnectorEndpoint(envPrefix: string, platform: PlatformName, operation: "drafts" | "status") {
  const endpointKey = `${envPrefix}_${operation === "drafts" ? "DRAFT_ENDPOINT" : "STATUS_ENDPOINT"}`;
  const explicitEndpoint = readEnvValue(endpointKey);
  if (explicitEndpoint) {
    return explicitEndpoint;
  }

  const baseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL");
  if (baseUrl) {
    return `${trimTrailingSlash(baseUrl)}/${platform}/${operation}`;
  }

  if (operation === "status") {
    return inferLocalConnectorEndpointFromDraftEndpoint(
      platform,
      readEnvValue(`${envPrefix}_DRAFT_ENDPOINT`),
      operation,
    );
  }

  return undefined;
}

function resolveDraftConnectorHealthUrl(platforms: DraftConnectorPlatformStatus[]) {
  const explicitHealthUrl = readEnvValue("DRAFT_CONNECTOR_HEALTH_URL");
  if (explicitHealthUrl) {
    return explicitHealthUrl;
  }

  const baseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL");
  if (baseUrl) {
    return `${trimTrailingSlash(baseUrl)}/health`;
  }

  for (const platform of platforms) {
    const inferredHealthUrl = inferLocalDraftConnectorHealthUrl(platform.platform, platform.draftEndpoint);
    if (inferredHealthUrl) {
      return inferredHealthUrl;
    }
  }

  return undefined;
}

function inferBaseUrlFromHealthUrl(healthUrl: string | undefined) {
  if (!healthUrl) {
    return undefined;
  }

  try {
    const url = new URL(healthUrl);
    if (url.pathname.replace(/\/+$/, "") !== "/health") {
      return undefined;
    }

    return trimTrailingSlash(url.origin);
  } catch {
    return undefined;
  }
}

@Injectable()
export class RuntimeService {
  private async getDraftConnectorStatus() {
    const platforms: DraftConnectorPlatformStatus[] = draftConnectorPlatforms.map(({ platform, envPrefix }) => ({
      platform,
      realPublishEnabled: isEnabled(`${envPrefix}_REAL_PUBLISH_ENABLED`),
      draftEndpoint: resolveConnectorEndpoint(envPrefix, platform, "drafts"),
      statusEndpoint: resolveConnectorEndpoint(envPrefix, platform, "status"),
    }));
    const hasConnectorConfig = platforms.some((platform) => platform.draftEndpoint || platform.statusEndpoint);
    const healthUrl = resolveDraftConnectorHealthUrl(platforms);

    if (!healthUrl) {
      return {
        status: hasConnectorConfig ? "configured" : "unconfigured",
        detail: hasConnectorConfig
          ? "Draft endpoints are configured directly; set DRAFT_CONNECTOR_HEALTH_URL or DRAFT_CONNECTOR_BASE_URL to enable health checks."
          : "Set DRAFT_CONNECTOR_BASE_URL to enable local draft connector health checks.",
        platforms,
      } satisfies {
        status: DraftConnectorStatus;
        detail: string;
        platforms: DraftConnectorPlatformStatus[];
      };
    }

    const normalizedBaseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL")
      ? trimTrailingSlash(readEnvValue("DRAFT_CONNECTOR_BASE_URL")!)
      : inferBaseUrlFromHealthUrl(healthUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(healthUrl, { signal: controller.signal });
      const payload = response.ok
        ? ((await response.json().catch(() => ({}))) as DraftConnectorHealthPayload)
        : {};
      const platformsWithUpstream = platforms.map((platformStatus) => {
        const upstreamStatus = payload.upstreamDrafts?.find((item) => item.platform === platformStatus.platform);

        return {
          ...platformStatus,
          upstreamDraftEndpointConfigured: upstreamStatus?.draftEndpointConfigured,
          upstreamStatusEndpointConfigured: upstreamStatus?.statusEndpointConfigured,
          upstreamCredentialForwardingEnabled: upstreamStatus?.credentialForwardingEnabled,
          upstreamStatusCredentialForwardingEnabled: upstreamStatus?.statusCredentialForwardingEnabled,
          upstreamDraftStatus: upstreamStatus?.status,
          upstreamDraftDetail: upstreamStatus?.detail,
          upstreamDraftHealthEndpoint: upstreamStatus?.healthEndpoint,
        };
      });

      return {
        status: response.ok ? "online" : "offline",
        baseUrl: normalizedBaseUrl,
        outboxUrl: normalizedBaseUrl ? `${normalizedBaseUrl}/drafts` : undefined,
        healthUrl,
        detail: response.ok
          ? `Draft connector is ${payload.status ?? "reachable"}.`
          : `Draft connector health check returned HTTP ${response.status}.`,
        outboxDir: payload.outboxDir,
        platforms: platformsWithUpstream,
      };
    } catch (error) {
      return {
        status: "offline",
        baseUrl: normalizedBaseUrl,
        outboxUrl: normalizedBaseUrl ? `${normalizedBaseUrl}/drafts` : undefined,
        healthUrl,
        detail: error instanceof Error ? error.message : "Draft connector health check failed.",
        platforms,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatus() {
    const [runtimeStats, draftConnector] = await Promise.all([
      getRuntimeStats(),
      this.getDraftConnectorStatus(),
    ]);

    return {
      ...runtimeStats,
      draftConnector,
    };
  }
}
