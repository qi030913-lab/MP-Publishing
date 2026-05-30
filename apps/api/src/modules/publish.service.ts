import { Injectable, NotFoundException } from "@nestjs/common";
import { adapterRegistry } from "@mp-publishing/adapter-core";
import { createDocumentFromInput } from "@mp-publishing/content-model";
import {
  findAccountById,
  findTaskById,
  listAccounts,
  listTasks,
  type PlatformAccountRecord,
  type PublishTaskLog,
  type PublishTaskMode,
  type PublishTaskRecord,
  type PublishTaskTargetRecord,
  upsertTask,
  updateAccount,
} from "@mp-publishing/task-runtime";

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

  private createBaseDocument(input: SimulatePublishDto | PublishMockDto) {
    return createDocumentFromInput({
      title: input.document.title,
      summary: input.document.summary,
      body: input.document.body,
      tags: input.document.tags,
      tone: "professional",
    });
  }

  private async refreshTaskAccounts(task: PublishTaskRecord) {
    const accounts = await listAccounts();
    task.targets = task.targets.map((target) => {
      if (!target.account) {
        return target;
      }

      const nextAccount = accounts.find((account) => account.id === target.account?.id) ?? target.account;
      return {
        ...target,
        account: nextAccount,
      };
    });
    task.status = this.summarizeTaskStatus(task.targets);
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

  private async createTaskFromInput(
    mode: PublishTaskMode,
    input: SimulatePublishDto | PublishMockDto,
  ): Promise<PublishTaskRecord> {
    const accounts = (await listAccounts()).filter((account) => input.accountIds.includes(account.id));
    const taskCreatedAt = this.createTimestamp();

    const document = this.createBaseDocument(input);

    const targets = await Promise.all(
      input.platforms.map(async (platform) => {
        const adapter = adapterRegistry.get(platform);
        const matchedAccount = accounts.find((account) => account.platform === platform) ?? null;
        const baseLogs = [
          this.createLog("info", mode === "simulate" ? `已创建 ${platform} 模拟发布任务。` : `已创建 ${platform} mock 发布任务。`),
          this.createLog("info", `${platform} 等待 worker 执行。`),
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
      status: this.summarizeTaskStatus(targets),
      documentTitle: document.title,
      createdAt: taskCreatedAt,
      updatedAt: this.createTimestamp(),
      targets,
    };

    await upsertTask(task);
    return task;
  }

  async simulate(input: SimulatePublishDto) {
    const task = await this.createTaskFromInput("simulate", input);
    return this.mapTaskForResponse(task);
  }

  async publishMock(input: PublishMockDto) {
    const task = await this.createTaskFromInput("mock-publish", input);
    return this.mapTaskForResponse(task);
  }

  async listTasks() {
    const tasks = await listTasks();

    return {
      items: tasks.map((task) => ({
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

  async getTask(taskId: string) {
    const task = await findTaskById(taskId);
    if (!task) {
      throw new NotFoundException("publish task not found");
    }

    const refreshedTask = await this.refreshTaskAccounts(task);
    await upsertTask(refreshedTask);
    return this.mapTaskForResponse(refreshedTask);
  }

  async retryTask(taskId: string, input: RetryPublishTaskDto) {
    const task = await findTaskById(taskId);
    if (!task) {
      throw new NotFoundException("publish task not found");
    }

    const refreshedTask = await this.refreshTaskAccounts(task);
    const targets = refreshedTask.targets.filter((target) =>
      input.platform ? target.platform === input.platform : target.status !== "succeeded",
    );

    for (const target of targets) {
      const runtimeAccount = target.account?.id ? await findAccountById(target.account.id) : null;
      target.account = runtimeAccount ?? target.account;
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
          const updatedAccount = await updateAccount(target.account.id, {
            health: "healthy",
            lastCheckedAt: this.createTimestamp(),
          });

          if (updatedAccount) {
            target.account = updatedAccount;
            target.logs.push(this.createLog("info", `${target.platform} 凭证刷新成功，状态已恢复健康。`));
          }
        }
      }
    }

    refreshedTask.status = this.summarizeTaskStatus(refreshedTask.targets);
    refreshedTask.updatedAt = this.createTimestamp();
    await upsertTask(refreshedTask);

    return this.mapTaskForResponse(refreshedTask);
  }
}
