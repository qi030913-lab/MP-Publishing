import { Injectable } from "@nestjs/common";
import { getRuntimeStats } from "@mp-publishing/task-runtime";
import type { PlatformName } from "@mp-publishing/platform-sdk";

type DraftConnectorStatus = "online" | "offline" | "configured" | "unconfigured";

type DraftConnectorPlatformStatus = {
  platform: PlatformName;
  realPublishEnabled: boolean;
  draftEndpoint?: string;
  statusEndpoint?: string;
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

function resolveConnectorEndpoint(envPrefix: string, platform: PlatformName, operation: "drafts" | "status") {
  const endpointKey = `${envPrefix}_${operation === "drafts" ? "DRAFT_ENDPOINT" : "STATUS_ENDPOINT"}`;
  const explicitEndpoint = readEnvValue(endpointKey);
  if (explicitEndpoint) {
    return explicitEndpoint;
  }

  const baseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL");
  return baseUrl ? `${trimTrailingSlash(baseUrl)}/${platform}/${operation}` : undefined;
}

@Injectable()
export class RuntimeService {
  private async getDraftConnectorStatus() {
    const baseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL");
    const platforms: DraftConnectorPlatformStatus[] = draftConnectorPlatforms.map(({ platform, envPrefix }) => ({
      platform,
      realPublishEnabled: isEnabled(`${envPrefix}_REAL_PUBLISH_ENABLED`),
      draftEndpoint: resolveConnectorEndpoint(envPrefix, platform, "drafts"),
      statusEndpoint: resolveConnectorEndpoint(envPrefix, platform, "status"),
    }));
    const hasConnectorConfig = platforms.some((platform) => platform.draftEndpoint || platform.statusEndpoint);

    if (!baseUrl) {
      return {
        status: hasConnectorConfig ? "configured" : "unconfigured",
        detail: hasConnectorConfig
          ? "Draft endpoints are configured directly; connector health cannot be probed without DRAFT_CONNECTOR_BASE_URL."
          : "Set DRAFT_CONNECTOR_BASE_URL to enable local draft connector health checks.",
        platforms,
      } satisfies {
        status: DraftConnectorStatus;
        detail: string;
        platforms: DraftConnectorPlatformStatus[];
      };
    }

    const normalizedBaseUrl = trimTrailingSlash(baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(`${normalizedBaseUrl}/health`, { signal: controller.signal });
      const payload = response.ok ? ((await response.json()) as { status?: string; outboxDir?: string }) : {};

      return {
        status: response.ok ? "online" : "offline",
        baseUrl: normalizedBaseUrl,
        outboxUrl: `${normalizedBaseUrl}/drafts`,
        detail: response.ok
          ? `Draft connector is ${payload.status ?? "reachable"}.`
          : `Draft connector health check returned HTTP ${response.status}.`,
        outboxDir: payload.outboxDir,
        platforms,
      };
    } catch (error) {
      return {
        status: "offline",
        baseUrl: normalizedBaseUrl,
        outboxUrl: `${normalizedBaseUrl}/drafts`,
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
