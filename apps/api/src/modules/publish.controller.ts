import { Body, Controller, Inject, Post } from "@nestjs/common";

import type { PublishMockDto, SimulatePublishDto } from "./publish.dto.js";
import { PublishService } from "./publish.service.js";

@Controller("publish")
export class PublishController {
  constructor(@Inject(PublishService) private readonly publishService: PublishService) {}

  @Post("simulate")
  simulate(@Body() body: SimulatePublishDto) {
    return this.publishService.simulate(body);
  }

  @Post("mock")
  mockPublish(@Body() body: PublishMockDto) {
    return this.publishService.publishMock(body);
  }
}
