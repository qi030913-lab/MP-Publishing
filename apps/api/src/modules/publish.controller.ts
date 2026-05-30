import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";

import type {
  PublishMockDto,
  PublishRealDto,
  RetryPublishTaskDto,
  SimulatePublishDto,
  SyncPublishTaskDto,
} from "./publish.dto.js";
import { PublishService } from "./publish.service.js";

@Controller("publish")
export class PublishController {
  constructor(@Inject(PublishService) private readonly publishService: PublishService) {}

  @Get("tasks")
  listTasks() {
    return this.publishService.listTasks();
  }

  @Get("tasks/:taskId")
  getTask(@Param("taskId") taskId: string) {
    return this.publishService.getTask(taskId);
  }

  @Post("simulate")
  simulate(@Body() body: SimulatePublishDto) {
    return this.publishService.simulate(body);
  }

  @Post("mock")
  mockPublish(@Body() body: PublishMockDto) {
    return this.publishService.publishMock(body);
  }

  @Post("real")
  realPublish(@Body() body: PublishRealDto) {
    return this.publishService.publishReal(body);
  }

  @Post("tasks/:taskId/retry")
  retryTask(@Param("taskId") taskId: string, @Body() body: RetryPublishTaskDto) {
    return this.publishService.retryTask(taskId, body);
  }

  @Post("tasks/:taskId/sync")
  syncTask(@Param("taskId") taskId: string, @Body() body: SyncPublishTaskDto) {
    return this.publishService.syncTask(taskId, body);
  }
}
