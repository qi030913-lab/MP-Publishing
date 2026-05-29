import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";
import { PlatformController } from "./platform.controller.js";

@Module({
  controllers: [HealthController, PlatformController],
})
export class AppModule {}
