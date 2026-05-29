import { Controller, Get } from "@nestjs/common";

import {
  adapterRegistry,
  summarizeCapabilities,
} from "@mp-publishing/adapter-core";

@Controller("platforms")
export class PlatformController {
  @Get()
  listPlatforms() {
    return summarizeCapabilities(adapterRegistry.listCapabilities());
  }
}
