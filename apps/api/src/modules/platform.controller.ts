import { Controller, Get } from "@nestjs/common";

import {
  adapterRegistry,
  summarizeCapabilities,
} from "@mp-publishing/adapter-core";

@Controller("platforms")
export class PlatformController {
  @Get()
  listPlatforms() {
    const capabilities = adapterRegistry.listCapabilities();

    return {
      items: summarizeCapabilities(capabilities),
      capabilities,
    };
  }
}
