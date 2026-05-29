import { Controller, Get, Inject, Param, Post } from "@nestjs/common";

import { AccountService } from "./account.service.js";

@Controller("accounts")
export class AccountController {
  constructor(@Inject(AccountService) private readonly accountService: AccountService) {}

  @Get()
  listAccounts() {
    return this.accountService.listAccounts();
  }

  @Post(":accountId/check")
  checkAccount(@Param("accountId") accountId: string) {
    return this.accountService.checkAccount(accountId);
  }

  @Post(":accountId/refresh")
  refreshCredential(@Param("accountId") accountId: string) {
    return this.accountService.refreshCredential(accountId);
  }

  @Post(":accountId/mark-needs-login")
  markNeedsLogin(@Param("accountId") accountId: string) {
    return this.accountService.markNeedsLogin(accountId);
  }
}
