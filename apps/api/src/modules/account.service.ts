import { Injectable, NotFoundException } from "@nestjs/common";

import {
  findAccountById,
  listAccounts,
  type PlatformAccountHealth,
  updateAccount,
} from "@mp-publishing/task-runtime";

@Injectable()
export class AccountService {
  private createTimestamp() {
    return new Date().toISOString();
  }

  private async getAccountOrThrow(accountId: string) {
    const account = await findAccountById(accountId);
    if (!account) {
      throw new NotFoundException("platform account not found");
    }

    return account;
  }

  async listAccounts() {
    const accounts = await listAccounts();
    return {
      items: accounts,
      summary: {
        total: accounts.length,
        healthy: accounts.filter((account) => account.health === "healthy").length,
        expiring: accounts.filter((account) => account.health === "expiring").length,
        needsLogin: accounts.filter((account) => account.health === "needs-login").length,
        credentialsConfigured: accounts.filter((account) => account.credentialStatus === "configured").length,
        credentialsMissing: accounts.filter((account) => account.credentialStatus === "missing").length,
        credentialsUnbound: accounts.filter((account) => account.credentialStatus === "unbound").length,
      },
    };
  }

  async checkAccount(accountId: string) {
    const account = await this.getAccountOrThrow(accountId);
    const nextHealth: PlatformAccountHealth =
      account.health === "healthy" ? "healthy" : account.health === "expiring" ? "expiring" : "needs-login";

    return updateAccount(account.id, {
      health: nextHealth,
      lastCheckedAt: this.createTimestamp(),
    });
  }

  async refreshCredential(accountId: string) {
    const account = await this.getAccountOrThrow(accountId);

    return updateAccount(account.id, {
      health: "healthy",
      lastCheckedAt: this.createTimestamp(),
    });
  }

  async markNeedsLogin(accountId: string) {
    const account = await this.getAccountOrThrow(accountId);

    return updateAccount(account.id, {
      health: "needs-login",
      lastCheckedAt: this.createTimestamp(),
    });
  }
}
