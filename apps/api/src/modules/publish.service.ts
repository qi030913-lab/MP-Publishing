import { Injectable, NotFoundException } from "@nestjs/common";
import { adapterRegistry } from "@mp-publishing/adapter-core";
import { createDocumentFromInput } from "@mp-publishing/content-model";

import {
  platformAccounts,
  publishTasks,
  type PlatformAccountRecord,
  type PublishTaskLog,
  type PublishTaskMode,
  type PublishTaskRecord,
  type PublishTaskTargetRecord,
} from "./publish.data.js";
import type {
  PublishMockDto,
  RetryPublishTaskDto,
  SimulatePublishDto,
} from "./publish.dto.js";

@Injectable()
export class PublishService {
  private createTimestamp() {
    return new Date().toISOString();
  }

  private createLog(level: PublishTaskLog["level"], message: string): PublishTaskLog {
    return {
      id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      timestamp: this.createTimestamp(),
      level,
      message,
    };
  }

  private summarizeTaskStatus(targets: PublishTaskTargetRecord[]): PublishTaskRecord["status"] {
    const statuses = targets.map((target) => target.status);

    if (statuses.every((status) => status === "succeeded")) {
      return "succeeded";
    }

    if (statuses.every((status) => status === "failed")) {
      return "failed";
    }

    return "partial";
  }

  private createBaseDocument(input: SimulatePublishDto | PublishMockDto) {
    return createDocumentFromInput({
      title: input.document.title,
      summary: input.document.summary,
      body: input.document.body,
      tags: input.document.tags,
      tone: "professional",
    });
  }

  private async createTaskFromInput(
    mode: PublishTaskMode,
    input: SimulatePublishDto | PublishMockDto,
  ): Promise<PublishTaskRecord> {
    const document = this.createBaseDocument(input);
    const accounts = platformAccounts.filter((account) => input.accountIds.includes(account.id));
    const taskCreatedAt = this.createTimestamp();

    const targets = await Promise.all(
      input.platforms.map(async (platform) => {
        const adapter = adapterRegistry.get(platform);
        const matchedAccount = accounts.find((account) => account.platform === platform);
        const startedAt = this.createTimestamp();

        if (mode === "simulate") {
          const simulateResult = await adapter.simulatePublish({
            accountId: matchedAccount?.id ?? `unbound-${platform}`,
            document,
            dryRun: true,
          });

          return {
            platform,
            account: matchedAccount ?? null,
            status: simulateResult.ok ? "succeeded" : "needs_retry",
            attemptCount: 1,
            screenshots: simulateResult.screenshots,
            issues: simulateResult.issues,
            logs: [
              this.createLog("info", `已开始 ${platform} 模拟发布预检。`),
              this.createLog(
                simulateResult.ok ? "info" : "warning",
                simulateResult.ok
                  ? `${platform} 模拟发布检查通过。`
                  : `${platform} 模拟发布存在待处理问题。`,
              ),
            ],
            startedAt,
            completedAt: this.createTimestamp(),
          } satisfies PublishTaskTargetRecord;
        }

        const publishResult = await adapter.publish({
          accountId: matchedAccount?.id ?? `unbound-${platform}`,
          document,
          dryRun: true,
        });

        return {
          platform,
          account: matchedAccount ?? null,
          status: publishResult.ok ? "succeeded" : "needs_retry",
          attemptCount: 1,
          remoteId: publishResult.remoteId,
          url: publishResult.url,
          issues: publishResult.issues,
          logs: [
            this.createLog("info", `已开始 ${platform} mock 发布。`),
            this.createLog(
              publishResult.ok ? "info" : "warning",
              publishResult.ok ? `${platform} mock 发布成功。` : `${platform} mock 发布部分失败。`,
            ),
          ],
          startedAt,
          completedAt: this.createTimestamp(),
        } satisfies PublishTaskTargetRecord;
      }),
    );

    const task: PublishTaskRecord = {
      id: `task_${Date.now()}`,
      mode,
      status: this.summarizeTaskStatus(targets),
      documentTitle: document.title,
      createdAt: taskCreatedAt,
      updatedAt: this.createTimestamp(),
      targets,
    };

    publishTasks.unshift(task);
    return task;
  }

  private mapTaskForResponse(task: PublishTaskRecord) {
    return {
      id: task.id,
      mode: task.mode,
      overallStatus:
        task.mode === "simulate"
          ? task.status === "succeeded"
            ? "ready"
            : "needs_attention"
          : task.status === "succeeded"
            ? "published"
            : "partial",
      documentTitle: task.documentTitle,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      results: task.targets.map((target) => ({
        platform: target.platform,
        account: target.account,
        ok: target.status === "succeeded",
        screenshots: target.screenshots,
        remoteId: target.remoteId,
        url: target.url,
        issues: target.issues,
        status: target.status,
        attemptCount: target.attemptCount,
        logs: target.logs,
      })),
    };
  }

  async simulate(input: SimulatePublishDto) {
    const task = await this.createTaskFromInput("simulate", input);
    return this.mapTaskForResponse(task);
  }

  async publishMock(input: PublishMockDto) {
    const task = await this.createTaskFromInput("mock-publish", input);
    return this.mapTaskForResponse(task);
  }

  listTasks() {
    return {
      items: publishTasks.map((task) => ({
        id: task.id,
        mode: task.mode,
        status: task.status,
        documentTitle: task.documentTitle,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        targetCount: task.targets.length,
        issueCount: task.targets.reduce((count, target) => count + target.issues.length, 0),
      })),
    };
  }

  getTask(taskId: string) {
    const task = publishTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new NotFoundException("publish task not found");
    }

    return this.mapTaskForResponse(task);
  }

  retryTask(taskId: string, input: RetryPublishTaskDto) {
    const task = publishTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new NotFoundException("publish task not found");
    }

    const targets = task.targets.filter((target) =>
      input.platform ? target.platform === input.platform : target.status !== "succeeded",
    );

    targets.forEach((target) => {
      const nextStatus = target.account ? "succeeded" : "needs_retry";
      target.attemptCount += 1;
      target.status = nextStatus;
      target.completedAt = this.createTimestamp();
      target.logs.push(this.createLog("info", `已执行第 ${target.attemptCount} 次重试。`));
      if (!target.account) {
        target.logs.push(this.createLog("warning", `${target.platform} 缺少账号绑定，重试后仍需人工处理。`));
      } else {
        target.logs.push(this.createLog("info", `${target.platform} 重试已成功完成。`));
      }
    });

    task.status = this.summarizeTaskStatus(task.targets);
    task.updatedAt = this.createTimestamp();

    return this.mapTaskForResponse(task);
  }

}
