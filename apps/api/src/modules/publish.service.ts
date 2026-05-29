import { Injectable } from "@nestjs/common";
import { adapterRegistry } from "@mp-publishing/adapter-core";
import { createDocumentFromInput } from "@mp-publishing/content-model";

import { platformAccounts } from "./publish.data.js";
import type { PublishMockDto, SimulatePublishDto } from "./publish.dto.js";

@Injectable()
export class PublishService {
  private createBaseDocument(input: SimulatePublishDto | PublishMockDto) {
    return createDocumentFromInput({
      title: input.document.title,
      summary: input.document.summary,
      body: input.document.body,
      tags: input.document.tags,
      tone: "professional",
    });
  }

  async simulate(input: SimulatePublishDto) {
    const document = this.createBaseDocument(input);
    const accounts = platformAccounts.filter((account) => input.accountIds.includes(account.id));

    const results = await Promise.all(
      input.platforms.map(async (platform) => {
        const adapter = adapterRegistry.get(platform);
        const matchedAccount = accounts.find((account) => account.platform === platform);
        const simulateResult = await adapter.simulatePublish({
          accountId: matchedAccount?.id ?? `unbound-${platform}`,
          document,
          dryRun: true,
        });

        return {
          platform,
          account: matchedAccount ?? null,
          ok: simulateResult.ok,
          screenshots: simulateResult.screenshots,
          issues: simulateResult.issues,
        };
      }),
    );

    return {
      mode: "simulate",
      document,
      overallStatus: results.every((item) => item.ok) ? "ready" : "needs_attention",
      results,
    };
  }

  async publishMock(input: PublishMockDto) {
    const document = this.createBaseDocument(input);
    const accounts = platformAccounts.filter((account) => input.accountIds.includes(account.id));

    const results = await Promise.all(
      input.platforms.map(async (platform) => {
        const adapter = adapterRegistry.get(platform);
        const matchedAccount = accounts.find((account) => account.platform === platform);
        const publishResult = await adapter.publish({
          accountId: matchedAccount?.id ?? `unbound-${platform}`,
          document,
          dryRun: true,
        });

        return {
          platform,
          account: matchedAccount ?? null,
          ok: publishResult.ok,
          remoteId: publishResult.remoteId,
          url: publishResult.url,
          issues: publishResult.issues,
        };
      }),
    );

    return {
      mode: "mock-publish",
      document,
      overallStatus: results.every((item) => item.ok) ? "published" : "partial",
      results,
    };
  }
}
