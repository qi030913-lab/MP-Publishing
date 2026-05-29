import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./modules/app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3001);
}

void bootstrap();
