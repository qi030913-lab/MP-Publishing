import { createAdapter } from "@mp-publishing/adapter-shared";

export const zhihuAdapter = createAdapter({
  platform: "zhihu",
  capabilities: {
    platform: "zhihu",
    titleMaxLength: 80,
    summaryMaxLength: 160,
    supportedBlocks: [
      "title",
      "paragraph",
      "heading",
      "blockquote",
      "list",
      "image",
      "codeBlock",
      "linkCard",
    ],
    supportsHtml: false,
    supportsMarkdown: true,
    supportsHashtags: false,
    supportsScheduling: false,
    publishMode: "official-api",
  },
  intro: "知乎更适合问题拆解与结论先行的内容结构。",
  bulletsStyle: "number",
  extraHashtags: ["#知乎回答"],
});
