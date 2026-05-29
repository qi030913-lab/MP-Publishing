import { createAdapter } from "@mp-publishing/adapter-shared";

export const wechatAdapter = createAdapter({
  platform: "wechat",
  capabilities: {
    platform: "wechat",
    titleMaxLength: 64,
    summaryMaxLength: 120,
    supportedBlocks: [
      "title",
      "subtitle",
      "paragraph",
      "heading",
      "blockquote",
      "list",
      "image",
      "imageGallery",
      "linkCard",
      "cta",
    ],
    supportsHtml: true,
    supportsMarkdown: false,
    supportsHashtags: false,
    supportsScheduling: true,
    publishMode: "official-api",
  },
  intro: "适合公众号图文排版的导语预览。",
  extraHashtags: ["#公众号排版"],
});
