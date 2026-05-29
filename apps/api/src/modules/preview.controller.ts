import { Body, Controller, Inject, Post } from "@nestjs/common";

import type { PreviewDocumentDto } from "./preview.dto.js";
import { PreviewService } from "./preview.service.js";

@Controller("preview")
export class PreviewController {
  constructor(@Inject(PreviewService) private readonly previewService: PreviewService) {}

  @Post()
  generatePreview(@Body() body: PreviewDocumentDto) {
    return this.previewService.generatePreview(body);
  }
}
