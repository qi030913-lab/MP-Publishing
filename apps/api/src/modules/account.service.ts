import { Injectable, NotFoundException } from "@nestjs/common";

import {
  findPlatformAccountById,
  type PlatformAccountHealth,
  platformAccounts,
  updatePlatformAccount,
} from "./publish.data.js";

@Injectable()
export class AccountService {
  private createTimestamp() {
    return new Date().toISOString();
  }

  private getAccountOrThrow(accountId: string) {
    const account = findPlatformAccountById(accountId);
    if (!account) {
      throw new NotFoundException("platform account not found");
    }

    return account;
  }

  listAccounts() {
    return {
      items: platformAccounts,
      summary: {
        total: platformAccounts.length,
        healthy: platformAccounts.filter((account) => account.health === "healthy").length,
        expiring: platformAccounts.filter((account) => account.health === "expiring").length,
        needsLogin: platformAccounts.filter((account) => account.health === "needs-login").length,
      },
    };
  }

  checkAccount(accountId: string) {
    const account = this.getAccountOrThrow(accountId);
    const nextHealth: PlatformAccountHealth =
      account.health === "healthy" ? "healthy" : account.health === "expiring" ? "expiring" : "needs-login";

    return updatePlatformAccount(account.id, {
      health: nextHealth,
      lastCheckedAt: this.createTimestamp(),
    });
  }

  refreshCredential(accountId: string) {
    const account = this.getAccountOrThrow(accountId);

    return updatePlatformAccount(account.id, {
      health: "healthy",
      lastCheckedAt: this.createTimestamp(),
    });
  }

  markNeedsLogin(accountId: string) {
    const account = this.getAccountOrThrow(accountId);

    return updatePlatformAccount(account.id, {
      health: "needs-login",
      lastCheckedAt: this.createTimestamp(),
    });
  }
}
