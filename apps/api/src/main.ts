import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { resetRuntimeState } from "@mp-publishing/task-runtime";

import { AppModule } from "./modules/app.module.js";

async function bootstrap() {
  await resetRuntimeState();
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(3001);
}

void bootstrap();
