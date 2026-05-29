import type { CanonicalDocument } from "@mp-publishing/content-model";
import type {
  AdaptOptions,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformDraft,
  PlatformName,
  PublishInput,
  PublishResult,
  SimulationResult,
  ValidationIssue,
} from "@mp-publishing/platform-sdk";

type AdapterPreset = {
  platform: PlatformName;
  capabilities: PlatformCapabilities;
  titleSuffix?: string;
  intro?: string;
  bulletsStyle?: "dash" | "number";
  extraHashtags?: string[];
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

      return {
        ok: issues.every((issue) => issue.severity !== "error"),
        screenshots: [`simulation://${preset.platform}/compose`],
        issues,
      };
    },
    async publish(input: PublishInput): Promise<PublishResult> {
      const issues = await this.validate(input.document);

      return {
        ok: true,
        remoteId: input.dryRun ? `dry-run-${preset.platform}` : `${preset.platform}-demo-remote-id`,
        url: `https://example.com/published/${preset.platform}`,
        issues,
      };
    },
    async getPublishStatus() {
      return {
        state: "succeeded",
        detail: `Demo ${preset.platform} adapter returns a mocked successful status.`,
      };
    },
  };
}
