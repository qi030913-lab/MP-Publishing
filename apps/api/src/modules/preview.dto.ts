import type { PlatformName } from "@mp-publishing/platform-sdk";

export type PreviewDocumentDto = {
  title: string;
  summary?: string;
  body: string;
  tags?: string[];
  platforms?: PlatformName[];
  toneMode?: "keep" | "platform-optimized";
  preserveOriginal?: boolean;
};
