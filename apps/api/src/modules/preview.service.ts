import { Injectable } from "@nestjs/common";
import { adapterRegistry } from "@mp-publishing/adapter-core";
import { createDocumentFromInput } from "@mp-publishing/content-model";

import type { PreviewDocumentDto } from "./preview.dto.js";

@Injectable()
export class PreviewService {
  async generatePreview(input: PreviewDocumentDto) {
    const document = createDocumentFromInput({
      title: input.title,
      summary: input.summary,
      body: input.body,
      tags: input.tags,
      tone: "professional",
    });

    const previews = await adapterRegistry.adaptDocument(
      document,
      {
        toneMode: input.toneMode ?? "platform-optimized",
        preserveOriginal: input.preserveOriginal ?? false,
      },
      input.platforms,
    );

    return {
      document,
      previews,
    };
  }
}
