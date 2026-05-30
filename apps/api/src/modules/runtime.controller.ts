import { Controller, Get, Inject } from "@nestjs/common";

import { RuntimeService } from "./runtime.service.js";

@Controller("runtime")
export class RuntimeController {
  constructor(@Inject(RuntimeService) private readonly runtimeService: RuntimeService) {}

  @Get("status")
  getStatus() {
    return this.runtimeService.getStatus();
  }
}
