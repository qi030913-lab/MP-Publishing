export type ContentBlockType =
  | "title"
  | "subtitle"
  | "paragraph"
  | "heading"
  | "blockquote"
  | "list"
  | "image"
  | "imageGallery"
  | "videoEmbed"
  | "codeBlock"
  | "callout"
  | "linkCard"
  | "tagGroup"
  | "cta";

export type ContentBlock = {
  id: string;
  type: ContentBlockType;
  text?: string;
  level?: number;
  items?: string[];
  assetIds?: string[];
};

export type AssetRef = {
  id: string;
  kind: "image" | "video";
  url: string;
  alt?: string;
};

export type CanonicalDocument = {
  id: string;
  title: string;
  summary?: string;
  blocks: ContentBlock[];
  assets: AssetRef[];
  metadata: {
    authorId: string;
    topics: string[];
    tone?: "professional" | "casual" | "storytelling" | "marketing";
    language: "zh-CN";
  };
};

export type CreateDocumentInput = {
  title: string;
  summary?: string;
  body: string;
  tags?: string[];
  tone?: CanonicalDocument["metadata"]["tone"];
  authorId?: string;
};

export const exampleDocument: CanonicalDocument = {
  id: "doc_demo_001",
  title: "一篇内容，如何高效同步到多个创作平台",
  summary: "统一内容模型是多平台发布系统的第一块基石。",
  blocks: [
    {
      id: "block_heading_1",
      type: "heading",
      text: "为什么创作者需要统一发布工作台",
      level: 2,
    },
    {
      id: "block_paragraph_1",
      type: "paragraph",
      text: "当同一篇内容需要同步到公众号、知乎、B站、小红书时，最大的成本往往不是创作本身，而是反复适配格式、标题、摘要和平台语气。",
    },
    {
      id: "block_list_1",
      type: "list",
      items: [
        "统一输入，拆分多端输出",
        "保留平台差异，但不重复劳动",
        "为一键发布和模拟发布提供稳定基础",
      ],
    },
  ],
  assets: [
    {
      id: "asset_cover_1",
      kind: "image",
      url: "https://example.com/assets/cover.png",
      alt: "多平台发布工作台封面",
    },
  ],
  metadata: {
    authorId: "author_demo",
    topics: ["content-ops", "creator-tools", "publishing"],
    tone: "professional",
    language: "zh-CN",
  },
};

export function createDocumentSummary(document: CanonicalDocument): string {
  return `${document.title} - ${document.blocks.length} blocks, ${document.assets.length} assets`;
}

function createParagraphBlock(text: string, index: number): ContentBlock {
  return {
    id: `block_paragraph_${index + 1}`,
    type: "paragraph",
    text,
  };
}

export function createDocumentFromInput(input: CreateDocumentInput): CanonicalDocument {
  const normalizedBody = input.body
    .split(/\r?\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const blocks =
    normalizedBody.length > 0
      ? normalizedBody.map(createParagraphBlock)
      : [createParagraphBlock("在这里开始创作内容。", 0)];

  return {
    id: `doc_${Date.now()}`,
    title: input.title.trim() || "未命名内容",
    summary: input.summary?.trim() || undefined,
    blocks,
    assets: [],
    metadata: {
      authorId: input.authorId ?? "workspace-author",
      topics: input.tags?.filter(Boolean) ?? [],
      tone: input.tone ?? "professional",
      language: "zh-CN",
    },
  };
}

export function documentToPlainText(document: CanonicalDocument): string {
  return document.blocks
    .flatMap((block) => {
      if (block.text) {
        return [block.text];
      }

      if (block.items) {
        return block.items;
      }

      return [];
    })
    .join("\n\n");
}
