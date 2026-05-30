import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { ensureRuntimeReady } from "@mp-publishing/task-runtime";

import { AppModule } from "./modules/app.module.js";

async function bootstrap() {
  await ensureRuntimeReady();
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
