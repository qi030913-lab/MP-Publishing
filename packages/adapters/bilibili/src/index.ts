import { createAdapter } from "@mp-publishing/adapter-shared";

export const bilibiliAdapter = createAdapter({
  platform: "bilibili",
  capabilities: {
    platform: "bilibili",
    titleMaxLength: 30,
    summaryMaxLength: 100,
    supportedBlocks: ["title", "paragraph", "heading", "list", "image", "videoEmbed", "tagGroup"],
    supportsHtml: false,
    supportsMarkdown: false,
    supportsHashtags: true,
    supportsScheduling: true,
    publishMode: "hybrid",
  },
  titleSuffix: " | B站稿件",
  intro: "B站稿件预览偏口语、强调观点和节奏。",
  extraHashtags: ["#B站创作"],
  realDraft: {
    envPrefix: "BILIBILI",
    remoteIdPrefix: "bilibili-draft",
    urlScheme: "bilibili",
  },
});
