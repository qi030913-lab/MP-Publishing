import type { CanonicalDocument } from "@mp-publishing/content-model";

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

export type PlatformCredential = {
  accountId: string;
  platform: PlatformName;
  credentialRef: string;
  authMode: "official-api" | "cookie-session" | "hybrid";
  appId?: string;
  appSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  cookies?: string;
  storageStateJson?: string;
  expiresAt?: string;
};

export type PublishInput = {
  accountId: string;
  document: CanonicalDocument;
  dryRun?: boolean;
  credential?: PlatformCredential;
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
