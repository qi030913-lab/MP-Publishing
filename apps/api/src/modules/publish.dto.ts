import type { PlatformName } from "@mp-publishing/platform-sdk";

type PublishDocumentDto = {
  title: string;
  summary?: string;
  body: string;
  tags?: string[];
};

export type SimulatePublishDto = {
  document: PublishDocumentDto;
  platforms: PlatformName[];
  accountIds: string[];
  toneMode?: "keep" | "platform-optimized";
  preserveOriginal?: boolean;
};

export type PublishMockDto = SimulatePublishDto;

export type PublishRealDto = SimulatePublishDto;

export type RetryPublishTaskDto = {
  platform?: PlatformName;
};
