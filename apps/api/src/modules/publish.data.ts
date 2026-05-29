import type { PlatformName, ValidationIssue } from "@mp-publishing/platform-sdk";

export type PlatformAccountRecord = {
  id: string;
  platform: PlatformName;
  displayName: string;
  handle: string;
  authMode: "official-api" | "cookie-session" | "hybrid";
  health: "healthy" | "expiring" | "needs-login";
  lastCheckedAt: string;
};

export type PublishTaskMode = "simulate" | "mock-publish";

export type PublishTaskTargetStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "needs_retry"
  | "failed"
  | "needs_manual_action";

export type PublishTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "needs_manual_action";

export type PublishTaskLog = {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type PublishTaskTargetRecord = {
  platform: PlatformName;
  account: PlatformAccountRecord | null;
  status: PublishTaskTargetStatus;
  attemptCount: number;
  remoteId?: string;
  url?: string;
  screenshots?: string[];
  issues: ValidationIssue[];
  logs: PublishTaskLog[];
  startedAt?: string;
  completedAt?: string;
};

export type PublishTaskRecord = {
  id: string;
  mode: PublishTaskMode;
  status: PublishTaskStatus;
  documentTitle: string;
  createdAt: string;
  updatedAt: string;
  targets: PublishTaskTargetRecord[];
};

export const platformAccounts: PlatformAccountRecord[] = [
  {
    id: "acct_wechat_main",
    platform: "wechat",
    displayName: "公众号主账号",
    handle: "创作者实验室",
    authMode: "official-api",
    health: "healthy",
    lastCheckedAt: "2026-05-29T22:00:00+08:00",
  },
  {
    id: "acct_zhihu_main",
    platform: "zhihu",
    displayName: "知乎创作账号",
    handle: "内容系统设计",
    authMode: "official-api",
    health: "healthy",
    lastCheckedAt: "2026-05-29T22:05:00+08:00",
  },
  {
    id: "acct_bilibili_main",
    platform: "bilibili",
    displayName: "B站视频号",
    handle: "效率创作手记",
    authMode: "hybrid",
    health: "expiring",
    lastCheckedAt: "2026-05-29T21:55:00+08:00",
  },
  {
    id: "acct_xhs_main",
    platform: "xiaohongshu",
    displayName: "小红书笔记号",
    handle: "创作效率观察",
    authMode: "hybrid",
    health: "healthy",
    lastCheckedAt: "2026-05-29T21:50:00+08:00",
  },
];

export const publishTasks: PublishTaskRecord[] = [];
