import { Controller, Get } from "@nestjs/common";

import { platformAccounts } from "./publish.data.js";

@Controller("accounts")
export class AccountController {
  @Get()
  listAccounts() {
    return {
      items: platformAccounts,
    };
  }
}
