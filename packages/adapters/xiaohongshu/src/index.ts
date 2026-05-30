import { createAdapter } from "@mp-publishing/adapter-shared";

export const xiaohongshuAdapter = createAdapter({
  platform: "xiaohongshu",
  capabilities: {
    platform: "xiaohongshu",
    titleMaxLength: 20,
    summaryMaxLength: 1000,
    supportedBlocks: ["title", "paragraph", "heading", "list", "image", "tagGroup"],
    supportsHtml: false,
    supportsMarkdown: false,
    supportsHashtags: true,
    supportsScheduling: false,
    publishMode: "hybrid",
  },
  intro: "小红书笔记预览偏体验感和标签氛围。",
  extraHashtags: ["#小红书运营"],
  realDraft: {
    envPrefix: "XIAOHONGSHU",
    remoteIdPrefix: "xiaohongshu-draft",
    urlScheme: "xiaohongshu",
  },
});
