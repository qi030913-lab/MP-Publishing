import type { CanonicalDocument } from "@mp-publishing/content-model";

type PlatformCapabilities = {
  platform: "xiaohongshu";
  titleMaxLength?: number;
  summaryMaxLength?: number;
  supportedBlocks: string[];
  supportsHtml: boolean;
  supportsMarkdown: boolean;
  supportsHashtags: boolean;
  supportsScheduling: boolean;
  publishMode: "official-api" | "automation" | "hybrid";
};

type ValidationIssue = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

type AdaptOptions = {
  toneMode: "keep" | "platform-optimized";
  preserveOriginal: boolean;
};

type PlatformDraft = {
  platform: "xiaohongshu";
  title: string;
  summary?: string;
  body: string;
  hashtags: string[];
  warnings: ValidationIssue[];
};

type PublishInput = {
  accountId: string;
  document: CanonicalDocument;
  dryRun?: boolean;
};

type SimulationResult = {
  ok: boolean;
  screenshots: string[];
  issues: ValidationIssue[];
};

type PublishResult = {
  ok: boolean;
  remoteId?: string;
  url?: string;
  issues: ValidationIssue[];
};

type PublishStatus = {
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

type PlatformAdapter = {
  platform: "xiaohongshu";
  getCapabilities(): PlatformCapabilities;
  validate(document: CanonicalDocument): Promise<ValidationIssue[]>;
  adapt(document: CanonicalDocument, options: AdaptOptions): Promise<PlatformDraft>;
  simulatePublish(input: PublishInput): Promise<SimulationResult>;
  publish(input: PublishInput): Promise<PublishResult>;
  getPublishStatus?(remoteId: string): Promise<PublishStatus>;
};

const capabilities: PlatformCapabilities = {
  platform: "xiaohongshu",
  titleMaxLength: 20,
  summaryMaxLength: 1000,
  supportedBlocks: ["title", "paragraph", "heading", "list", "image", "tagGroup"],
  supportsHtml: false,
  supportsMarkdown: false,
  supportsHashtags: true,
  supportsScheduling: false,
  publishMode: "hybrid",
};

function toSentenceList(document: CanonicalDocument): string[] {
  return document.blocks.flatMap((block) => {
    if (block.text) {
      return [block.text];
    }
    if (block.items) {
      return block.items.map((item) => `- ${item}`);
    }
    return [];
  });
}

function buildTitle(document: CanonicalDocument, options: AdaptOptions): string {
  if (options.preserveOriginal || document.title.length <= (capabilities.titleMaxLength ?? 20)) {
    return document.title;
  }
  return `${document.title.slice(0, 17)}...`;
}

export const xiaohongshuAdapter: PlatformAdapter = {
  platform: "xiaohongshu",
  getCapabilities() {
    return capabilities;
  },
  async validate(document) {
    const issues: ValidationIssue[] = [];

    if (document.title.length > (capabilities.titleMaxLength ?? 20)) {
      issues.push({
        code: "TITLE_TOO_LONG",
        message: "Title exceeds Xiaohongshu recommendation length.",
        severity: "warning",
      });
    }

    if (document.assets.length === 0) {
      issues.push({
        code: "MISSING_IMAGE",
        message: "Xiaohongshu posts are stronger with at least one image asset.",
        severity: "info",
      });
    }

    return issues;
  },
  async adapt(document, options) {
    const warnings = await this.validate(document);
    const body = toSentenceList(document).join("\n\n");
    const hashtags = document.metadata.topics.map((topic) => `#${topic}`);

    return {
      platform: "xiaohongshu",
      title: buildTitle(document, options),
      summary: document.summary,
      body,
      hashtags,
      warnings,
    };
  },
  async simulatePublish(input) {
    const issues = await this.validate(input.document);

    return {
      ok: issues.every((issue) => issue.severity !== "error"),
      screenshots: ["simulation://xiaohongshu/fill-form"],
      issues,
    };
  },
  async publish(input) {
    const issues = await this.validate(input.document);

    if (input.dryRun) {
      return {
        ok: true,
        remoteId: "dry-run-xhs",
        url: "https://example.com/dry-run/xiaohongshu",
        issues,
      };
    }

    return {
      ok: true,
      remoteId: "xhs_demo_remote_id",
      url: "https://example.com/published/xiaohongshu",
      issues,
    };
  },
  async getPublishStatus() {
    return {
      state: "succeeded",
      detail: "Demo adapter returns a mocked successful status.",
    };
  },
};
