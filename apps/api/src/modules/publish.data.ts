import type { PlatformName } from "@mp-publishing/platform-sdk";

export type PlatformAccountRecord = {
  id: string;
  platform: PlatformName;
  displayName: string;
  handle: string;
  authMode: "official-api" | "cookie-session" | "hybrid";
  health: "healthy" | "expiring" | "needs-login";
  lastCheckedAt: string;
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
