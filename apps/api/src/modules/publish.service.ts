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
  private readonly progressDelayMs = 1500;

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

    if (statuses.some((status) => status === "running" || status === "queued")) {
      return "running";
    }

    if (statuses.some((status) => status === "needs_manual_action")) {
      return "needs_manual_action";
    }

    if (statuses.every((status) => status === "succeeded")) {
      return "succeeded";
    }

    if (statuses.every((status) => status === "failed")) {
      return "failed";
    }

    return "partial";
  }

  private resolveInitialTargetStatus(account: PlatformAccountRecord | null): PublishTaskTargetRecord["status"] {
    if (!account) {
      return "needs_manual_action";
    }

    if (account.health === "needs-login") {
      return "needs_manual_action";
    }

    return "queued";
  }

  private progressTask(task: PublishTaskRecord) {
    const now = Date.now();
    let changed = false;

    task.targets.forEach((target) => {
      if (target.status === "queued") {
        target.status = "running";
        target.startedAt = this.createTimestamp();
        target.logs.push(this.createLog("info", `${target.platform} 已进入执行队列。`));
        changed = true;
        return;
      }

      if (target.status !== "running" || !target.startedAt) {
        return;
      }

      const elapsed = now - new Date(target.startedAt).getTime();
      if (elapsed < this.progressDelayMs) {
        return;
      }

      if (!target.account || target.account.health === "needs-login") {
        target.status = "needs_manual_action";
        target.logs.push(this.createLog("warning", `${target.platform} 需要人工登录后才能继续发布。`));
        changed = true;
        return;
      }

      if (target.account.health === "expiring" && target.attemptCount === 1) {
        target.status = "needs_retry";
        target.logs.push(this.createLog("warning", `${target.platform} 账号凭证接近过期，建议执行重试。`));
        changed = true;
        return;
      }

      target.status = "succeeded";
      target.completedAt = this.createTimestamp();
      target.logs.push(this.createLog("info", `${target.platform} 任务执行完成。`));
      changed = true;
    });

    if (changed) {
      task.status = this.summarizeTaskStatus(task.targets);
      task.updatedAt = this.createTimestamp();
    }
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
    const accounts = platformAccounts.filter((account) => input.accountIds.includes(account.id));
    const taskCreatedAt = this.createTimestamp();

    const document = this.createBaseDocument(input);

    const targets = await Promise.all(
      input.platforms.map(async (platform) => {
        const adapter = adapterRegistry.get(platform);
        const matchedAccount = accounts.find((account) => account.platform === platform) ?? null;
        const baseLogs = [
          this.createLog("info", mode === "simulate" ? `已创建 ${platform} 模拟发布任务。` : `已创建 ${platform} mock 发布任务。`),
        ];

        if (mode === "simulate") {
          const simulateResult = await adapter.simulatePublish({
            accountId: matchedAccount?.id ?? `unbound-${platform}`,
            document,
            dryRun: true,
          });

          return {
            platform,
            account: matchedAccount,
            status: this.resolveInitialTargetStatus(matchedAccount),
            attemptCount: 1,
            screenshots: simulateResult.screenshots,
            issues: simulateResult.issues,
            logs: baseLogs,
          } satisfies PublishTaskTargetRecord;
        }

        const publishResult = await adapter.publish({
          accountId: matchedAccount?.id ?? `unbound-${platform}`,
          document,
          dryRun: true,
        });

        return {
          platform,
          account: matchedAccount,
          status: this.resolveInitialTargetStatus(matchedAccount),
          attemptCount: 1,
          remoteId: publishResult.remoteId,
          url: publishResult.url,
          issues: publishResult.issues,
          logs: baseLogs,
        } satisfies PublishTaskTargetRecord;
      }),
    );

    const task: PublishTaskRecord = {
      id: `task_${Date.now()}`,
      mode,
      status: "queued",
      documentTitle: document.title,
      createdAt: taskCreatedAt,
      updatedAt: this.createTimestamp(),
      targets,
    };

    publishTasks.unshift(task);
    return task;
  }

  private mapTaskForResponse(task: PublishTaskRecord) {
    this.progressTask(task);

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
      status: task.status,
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
        startedAt: target.startedAt,
        completedAt: target.completedAt,
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
      items: publishTasks.map((task) => {
        this.progressTask(task);
        return {
          id: task.id,
          mode: task.mode,
          status: task.status,
          documentTitle: task.documentTitle,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          targetCount: task.targets.length,
          issueCount: task.targets.reduce((count, target) => count + target.issues.length, 0),
        };
      }),
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
      target.attemptCount += 1;
      target.status = this.resolveInitialTargetStatus(target.account);
      target.startedAt = undefined;
      target.completedAt = undefined;
      target.logs.push(this.createLog("info", `已执行第 ${target.attemptCount} 次重试。`));
      if (!target.account) {
        target.logs.push(this.createLog("warning", `${target.platform} 缺少账号绑定，重试后仍需人工处理。`));
      } else {
        target.logs.push(this.createLog("info", `${target.platform} 已重新排入执行队列。`));
        if (target.account.health === "expiring") {
          target.account = {
            ...target.account,
            health: "healthy",
            lastCheckedAt: this.createTimestamp(),
          };
          target.logs.push(this.createLog("info", `${target.platform} 凭证刷新成功，状态已恢复健康。`));
        }
      }
    });

    task.status = this.summarizeTaskStatus(task.targets);
    task.updatedAt = this.createTimestamp();

    return this.mapTaskForResponse(task);
  }

}
