import type { CanonicalDocument } from "@mp-publishing/content-model";
import { exampleDocument } from "@mp-publishing/content-model";

import { xiaohongshuAdapter } from "@mp-publishing/adapter-xiaohongshu";

export type PlatformName = "wechat" | "zhihu" | "bilibili" | "xiaohongshu";

export type PlatformCapabilities = {
  platform: PlatformName;
  titleMaxLength?: number;
  summaryMaxLength?: number;
  supportedBlocks: string[];
  supportsHtml: boolean;
  supportsMarkdown: boolean;
  supportsHashtags: boolean;
  supportsScheduling: boolean;
  publishMode: "official-api" | "automation" | "hybrid";
};

export type ValidationIssue = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

export type AdaptOptions = {
  toneMode: "keep" | "platform-optimized";
  preserveOriginal: boolean;
};

export type PlatformDraft = {
  platform: PlatformName;
  title: string;
  summary?: string;
  body: string;
  hashtags: string[];
  warnings: ValidationIssue[];
};

export type PublishInput = {
  accountId: string;
  document: CanonicalDocument;
  dryRun?: boolean;
};

export type SimulationResult = {
  ok: boolean;
  screenshots: string[];
  issues: ValidationIssue[];
};

export type PublishResult = {
  ok: boolean;
  remoteId?: string;
  url?: string;
  issues: ValidationIssue[];
};

export type PublishStatus = {
  state:
    | "draft"
    | "adapting"
    | "ready"
    | "publishing"
    | "partially_succeeded"
    | "succeeded"
    | "failed"
    | "needs_manual_action";
  detail?: string;
};

export interface PlatformAdapter {
  platform: PlatformName;
  getCapabilities(): PlatformCapabilities;
  validate(document: CanonicalDocument): Promise<ValidationIssue[]>;
  adapt(document: CanonicalDocument, options: AdaptOptions): Promise<PlatformDraft>;
  simulatePublish(input: PublishInput): Promise<SimulationResult>;
  publish(input: PublishInput): Promise<PublishResult>;
  getPublishStatus?(remoteId: string): Promise<PublishStatus>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<PlatformName, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: PlatformName): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`adapter not found for platform: ${platform}`);
    }
    return adapter;
  }

  listCapabilities(): PlatformCapabilities[] {
    return Array.from(this.adapters.values()).map((adapter) => adapter.getCapabilities());
  }
}

export const adapterRegistry = new AdapterRegistry();

adapterRegistry.register(xiaohongshuAdapter);

export function summarizeCapabilities(capabilities: PlatformCapabilities[]) {
  return capabilities.map((capability) => ({
    platform: capability.platform,
    summary: `${capability.platform}: ${capability.supportedBlocks.length} block types, publish via ${capability.publishMode}`,
  }));
}

export async function buildPreviewSample() {
  return xiaohongshuAdapter.adapt(exampleDocument, {
    toneMode: "platform-optimized",
    preserveOriginal: false,
  });
}
