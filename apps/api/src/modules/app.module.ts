import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";
import { PlatformController } from "./platform.controller.js";
import { PreviewController } from "./preview.controller.js";
import { PreviewService } from "./preview.service.js";

@Module({
  controllers: [HealthController, PlatformController, PreviewController],
  providers: [PreviewService],
})
export class AppModule {}
