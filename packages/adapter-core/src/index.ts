import type { CanonicalDocument } from "@mp-publishing/content-model";
import { exampleDocument } from "@mp-publishing/content-model";
import type {
  AdaptOptions,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformDraft,
  PlatformName,
} from "@mp-publishing/platform-sdk";
import { bilibiliAdapter } from "@mp-publishing/adapter-bilibili";
import { wechatAdapter } from "@mp-publishing/adapter-wechat";
import { xiaohongshuAdapter } from "@mp-publishing/adapter-xiaohongshu";
import { zhihuAdapter } from "@mp-publishing/adapter-zhihu";

export type { AdaptOptions, PlatformCapabilities, PlatformDraft, PlatformName } from "@mp-publishing/platform-sdk";

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

  async adaptDocument(
    document: CanonicalDocument,
    options: AdaptOptions,
    platforms?: PlatformName[],
  ): Promise<PlatformDraft[]> {
    const targets = platforms && platforms.length > 0 ? platforms : Array.from(this.adapters.keys());

    return Promise.all(targets.map((platform) => this.get(platform).adapt(document, options)));
  }
}

export const adapterRegistry = new AdapterRegistry();

adapterRegistry.register(wechatAdapter);
adapterRegistry.register(zhihuAdapter);
adapterRegistry.register(bilibiliAdapter);
adapterRegistry.register(xiaohongshuAdapter);

export function summarizeCapabilities(capabilities: PlatformCapabilities[]) {
  return capabilities.map((capability) => ({
    platform: capability.platform,
    summary: `${capability.platform}: ${capability.supportedBlocks.length} block types, publish via ${capability.publishMode}`,
  }));
}

export async function buildPreviewSample() {
  return adapterRegistry.adaptDocument(exampleDocument, {
    toneMode: "platform-optimized",
    preserveOriginal: false,
  });
}
