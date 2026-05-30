import { Module } from "@nestjs/common";

import { AccountController } from "./account.controller.js";
import { AccountService } from "./account.service.js";
import { HealthController } from "./health.controller.js";
import { PlatformController } from "./platform.controller.js";
import { PublishController } from "./publish.controller.js";
import { PublishService } from "./publish.service.js";
import { PreviewController } from "./preview.controller.js";
import { PreviewService } from "./preview.service.js";
import { RuntimeController } from "./runtime.controller.js";
import { RuntimeService } from "./runtime.service.js";

@Module({
  controllers: [
    AccountController,
    HealthController,
    PlatformController,
    PreviewController,
    PublishController,
    RuntimeController,
  ],
  providers: [AccountService, PreviewService, PublishService, RuntimeService],
})
export class AppModule {}
