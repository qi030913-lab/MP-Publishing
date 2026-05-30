export type PlatformName = "wechat" | "zhihu" | "bilibili" | "xiaohongshu";

export type ToneMode = "keep" | "platform-optimized";

export type DraftDocument = {
  title: string;
  summary?: string;
  body: string;
  tags: string[];
  platforms: PlatformName[];
  toneMode: ToneMode;
  preserveOriginal: boolean;
};

export type ValidationIssue = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

export type PreviewResult = {
  platform: PlatformName;
  title: string;
  summary?: string;
  body: string;
  hashtags: string[];
  warnings: ValidationIssue[];
};

export type PlatformCapability = {
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

export type PlatformAccount = {
  id: string;
  platform: PlatformName;
  displayName: string;
  handle: string;
  authMode: "official-api" | "cookie-session" | "hybrid";
  health: "healthy" | "expiring" | "needs-login";
  credentialRef?: string;
  credentialStatus: "unbound" | "missing" | "configured";
  lastCheckedAt: string;
};

export type AccountSummary = {
  total: number;
  healthy: number;
  expiring: number;
  needsLogin: number;
  credentialsConfigured: number;
  credentialsMissing: number;
  credentialsUnbound: number;
};

export type TaskTargetStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "needs_retry"
  | "failed"
  | "needs_manual_action";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "needs_manual_action";

export type TaskResult = {
  platform: PlatformName;
  account: PlatformAccount | null;
  ok: boolean;
  screenshots?: string[];
  remoteId?: string;
  url?: string;
  issues: ValidationIssue[];
  status: TaskTargetStatus;
  attemptCount: number;
  startedAt?: string;
  completedAt?: string;
  logs: Array<{
    id: string;
    timestamp: string;
    level: "info" | "warning" | "error";
    message: string;
  }>;
};

export type PublishTaskDetail = {
  id: string;
  mode: "simulate" | "mock-publish" | "real-publish";
  overallStatus: "ready" | "needs_attention" | "published" | "partial";
  status: TaskStatus;
  documentTitle: string;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{
    id: string;
    timestamp: string;
    level: "info" | "warning" | "error";
    stage:
      | "created"
      | "queued"
      | "running"
      | "needs_retry"
      | "needs_manual_action"
      | "retrying"
      | "succeeded"
      | "failed";
    message: string;
    platform?: PlatformName;
  }>;
  results: TaskResult[];
};

export type PublishTaskSummary = {
  id: string;
  mode: "simulate" | "mock-publish" | "real-publish";
  status: TaskStatus;
  documentTitle: string;
  createdAt: string;
  updatedAt: string;
  targetCount: number;
  issueCount: number;
  platforms: PlatformName[];
  targetStatuses: Array<{
    platform: PlatformName;
    status: TaskTargetStatus;
  }>;
};

export type RuntimeStatus = {
  worker: {
    name: string;
    status: "idle" | "working" | "offline";
    lastHeartbeatAt?: string;
    lastProcessedTaskId?: string;
    currentTaskId?: string;
    processedCount: number;
  };
  queue: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  };
  tasks: {
    total: number;
    queuedCount: number;
    runningCount: number;
    needsRetryCount: number;
    manualActionCount: number;
    succeededCount: number;
  };
  draftConnector: {
    status: "online" | "offline" | "configured" | "unconfigured";
    baseUrl?: string;
    outboxUrl?: string;
    outboxDir?: string;
    detail: string;
    platforms: Array<{
      platform: PlatformName;
      realPublishEnabled: boolean;
      draftEndpoint?: string;
      statusEndpoint?: string;
    }>;
  };
};
