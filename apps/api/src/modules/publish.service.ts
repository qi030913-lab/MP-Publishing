import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createDocumentFromInput } from "@mp-publishing/content-model";
import { adapterRegistry } from "@mp-publishing/adapter-core";
import type { PlatformName, PublishStatus, ValidationIssue } from "@mp-publishing/platform-sdk";
import {
  createContentSnapshot,
  enqueueTaskTargets,
  findAccountById,
  findTaskById,
  listAccounts,
  listTasks,
  resolvePlatformCredential,
  type PlatformAccountRecord,
  type PublishTaskEvent,
  type PublishTaskLog,
  type PublishTaskMode,
  type PublishTaskRecord,
  type PublishTaskTargetRecord,
  upsertTask,
  updateAccount,
} from "@mp-publishing/task-runtime";

import type {
  PublishMockDto,
  PublishRealDto,
  RetryPublishTaskDto,
  SimulatePublishDto,
  SyncPublishTaskDto,
} from "./publish.dto.js";

const draftConnectorPlatforms: Partial<Record<PlatformName, { envPrefix: string }>> = {
  zhihu: { envPrefix: "ZHIHU" },
  bilibili: { envPrefix: "BILIBILI" },
  xiaohongshu: { envPrefix: "XIAOHONGSHU" },
};

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isEnabled(key: string) {
  return readEnvValue(key)?.toLowerCase() === "true";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveDraftEndpoint(platform: PlatformName, envPrefix: string) {
  const explicitEndpoint = readEnvValue(`${envPrefix}_DRAFT_ENDPOINT`);
  if (explicitEndpoint) {
    return explicitEndpoint;
  }

  const baseUrl = readEnvValue("DRAFT_CONNECTOR_BASE_URL");
  return baseUrl ? `${trimTrailingSlash(baseUrl)}/${platform}/drafts` : undefined;
}

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

  private createEvent(
    stage: PublishTaskEvent["stage"],
    level: PublishTaskEvent["level"],
    message: string,
    platform?: PublishTaskEvent["platform"],
  ): PublishTaskEvent {
    return {
      id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      timestamp: this.createTimestamp(),
      level,
      stage,
      message,
      platform,
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

  private createIssue(code: string, message: string, severity: ValidationIssue["severity"] = "error"): ValidationIssue {
    return { code, message, severity };
  }

  private preflightRealDraftTarget(platform: PlatformName) {
    const connectorConfig = draftConnectorPlatforms[platform];
    const issues: ValidationIssue[] = [];

    if (!connectorConfig) {
      return issues;
    }

    const enabledKey = `${connectorConfig.envPrefix}_REAL_PUBLISH_ENABLED`;
    if (!isEnabled(enabledKey)) {
      issues.push(
        this.createIssue(
          `${platform.toUpperCase()}_REAL_PUBLISH_DISABLED`,
          `Set ${enabledKey}=true before creating a real ${platform} draft.`,
        ),
      );
    }

    if (!resolveDraftEndpoint(platform, connectorConfig.envPrefix)) {
      issues.push(
        this.createIssue(
          `${platform.toUpperCase()}_DRAFT_ENDPOINT_MISSING`,
          `Configure ${connectorConfig.envPrefix}_DRAFT_ENDPOINT or DRAFT_CONNECTOR_BASE_URL before creating a real ${platform} draft.`,
        ),
      );
    }

    return issues;
  }

  private mapRemoteStateToTargetStatus(state: PublishStatus["state"]): PublishTaskTargetRecord["status"] {
    if (state === "succeeded" || state === "draft" || state === "ready" || state === "partially_succeeded") {
      return "succeeded";
    }

    if (state === "failed") {
      return "failed";
    }

    if (state === "needs_manual_action") {
      return "needs_manual_action";
    }

    return "running";
  }

  private createBaseDocument(input: SimulatePublishDto | PublishMockDto | PublishRealDto) {
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
      timeline: task.timeline,
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
    input: SimulatePublishDto | PublishMockDto | PublishRealDto,
  ): Promise<PublishTaskRecord> {
    const accounts = (await listAccounts()).filter((account) => input.accountIds.includes(account.id));
    const taskCreatedAt = this.createTimestamp();

    const document = this.createBaseDocument(input);
    const contentSnapshot = await createContentSnapshot(document);

    const targets = input.platforms.map((platform) => {
        const matchedAccount = accounts.find((account) => account.platform === platform) ?? null;
        const preflightIssues = mode === "real-publish" ? this.preflightRealDraftTarget(platform) : [];
        const initialStatus = this.resolveInitialTargetStatus(matchedAccount);
        const targetStatus =
          initialStatus === "queued" && preflightIssues.length > 0 ? "needs_manual_action" : initialStatus;
        const baseLogs = [
          this.createLog(
            "info",
            mode === "simulate"
              ? `已创建 ${platform} 模拟发布任务。`
              : mode === "real-publish"
                ? `已创建 ${platform} 真实发布任务。`
                : `已创建 ${platform} mock 发布任务。`,
          ),
          this.createLog("info", `${platform} 等待 BullMQ worker 执行。`),
        ];

        if (targetStatus !== "queued") {
          baseLogs.pop();
          baseLogs.push(
            this.createLog(
              "warning",
              preflightIssues.length > 0
                ? `${platform} real draft preflight did not pass; connector configuration needs manual action.`
                : `${platform} requires manual action before queueing.`,
            ),
          );
        }

        return {
          platform,
          account: matchedAccount,
          status: targetStatus,
          attemptCount: 1,
          screenshots: [],
          issues: preflightIssues,
          logs: baseLogs,
        } satisfies PublishTaskTargetRecord;
      });

    const task: PublishTaskRecord = {
      id: `task_${Date.now()}`,
      mode,
      status: this.summarizeTaskStatus(targets),
      documentTitle: document.title,
      documentId: contentSnapshot.documentId,
      versionId: contentSnapshot.versionId,
      createdAt: taskCreatedAt,
      updatedAt: this.createTimestamp(),
      timeline: [
        this.createEvent(
          "created",
          "info",
          mode === "simulate"
            ? "已创建模拟发布任务。"
            : mode === "real-publish"
              ? "已创建真实平台发布任务。"
              : "已创建 mock 一键发布任务。",
        ),
        ...targets.map((target) =>
          this.createEvent(
            target.status === "needs_manual_action" ? "needs_manual_action" : "queued",
            target.status === "needs_manual_action" ? "warning" : "info",
            target.status === "needs_manual_action"
              ? `${target.platform} 初始化时需要人工处理。`
              : `${target.platform} 已进入 BullMQ 发布队列，等待 worker 执行。`,
            target.platform,
          ),
        ),
      ],
      targets,
    };

    const savedTask = await upsertTask(task);
    if (!savedTask) {
      throw new Error("failed to create publish task");
    }

    await enqueueTaskTargets(savedTask.id);
    return savedTask;
  }

  async simulate(input: SimulatePublishDto) {
    const task = await this.createTaskFromInput("simulate", input);
    return this.mapTaskForResponse(task);
  }

  async publishMock(input: PublishMockDto) {
    const task = await this.createTaskFromInput("mock-publish", input);
    return this.mapTaskForResponse(task);
  }

  async publishReal(input: PublishRealDto) {
    const task = await this.createTaskFromInput("real-publish", input);
    return this.mapTaskForResponse(task);
  }

  async listTasks() {
    const tasks = await listTasks();
    const sortedTasks = [...tasks].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );

    return {
      items: sortedTasks.map((task) => ({
        id: task.id,
        mode: task.mode,
        status: task.status,
        documentTitle: task.documentTitle,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        targetCount: task.targets.length,
        issueCount: task.targets.reduce((count, target) => count + target.issues.length, 0),
        platforms: task.targets.map((target) => target.platform),
        targetStatuses: task.targets.map((target) => ({
          platform: target.platform,
          status: target.status,
        })),
      })),
    };
  }

  async getTask(taskId: string) {
    const task = await findTaskById(taskId);
    if (!task) {
      throw new NotFoundException("publish task not found");
    }

    const refreshedTask = await this.refreshTaskAccounts(task);
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
      refreshedTask.timeline.push(
        this.createEvent("retrying", "info", `${target.platform} 已执行第 ${target.attemptCount} 次重试。`, target.platform),
      );
      if (!target.account) {
        target.logs.push(this.createLog("warning", `${target.platform} 缺少账号绑定，重试后仍需人工处理。`));
        refreshedTask.timeline.push(
          this.createEvent(
            "needs_manual_action",
            "warning",
            `${target.platform} 重试后仍缺少账号绑定。`,
            target.platform,
          ),
        );
      } else {
        target.logs.push(this.createLog("info", `${target.platform} 已重新排入 BullMQ 执行队列。`));
        refreshedTask.timeline.push(
          this.createEvent("queued", "info", `${target.platform} 已重新排入 BullMQ 执行队列。`, target.platform),
        );
        if (target.account.health === "expiring") {
          const updatedAccount = await updateAccount(target.account.id, {
            health: "healthy",
            lastCheckedAt: this.createTimestamp(),
          });

          if (updatedAccount) {
            target.account = updatedAccount;
            target.logs.push(this.createLog("info", `${target.platform} 凭证刷新成功，状态已恢复健康。`));
            refreshedTask.timeline.push(
              this.createEvent("running", "info", `${target.platform} 凭证刷新成功，准备重新执行。`, target.platform),
            );
          }
        }
      }
    }

    refreshedTask.status = this.summarizeTaskStatus(refreshedTask.targets);
    refreshedTask.updatedAt = this.createTimestamp();
    const savedTask = await upsertTask(refreshedTask);
    await enqueueTaskTargets(refreshedTask.id, input.platform);

    return this.mapTaskForResponse(savedTask ?? refreshedTask);
  }

  async syncTask(taskId: string, input: SyncPublishTaskDto) {
    const task = await findTaskById(taskId);
    if (!task) {
      throw new NotFoundException("publish task not found");
    }

    const refreshedTask = await this.refreshTaskAccounts(task);
    const targets = refreshedTask.targets.filter((target) => {
      if (input.platform) {
        return target.platform === input.platform;
      }

      return refreshedTask.mode === "real-publish" || target.platform === "wechat";
    });

    if (targets.length === 0) {
      throw new BadRequestException("no syncable publish targets found");
    }

    for (const target of targets) {
      if (!target.id) {
        continue;
      }

      if (!target.remoteId || target.url?.startsWith("wechat://draft/")) {
        const message = `${target.platform} 当前只有草稿或本地结果，暂无远程发布状态可同步。`;
        target.logs.push(this.createLog("info", message));
        refreshedTask.timeline.push(this.createEvent("running", "info", message, target.platform));
        continue;
      }

      if (!target.account) {
        const message = `${target.platform} 缺少账号绑定，无法查询远程发布状态。`;
        target.status = "needs_manual_action";
        target.logs.push(this.createLog("warning", message));
        refreshedTask.timeline.push(this.createEvent("needs_manual_action", "warning", message, target.platform));
        continue;
      }

      const adapter = adapterRegistry.get(target.platform);
      if (!adapter.getPublishStatus) {
        const message = `${target.platform} 暂未实现远程状态查询。`;
        target.logs.push(this.createLog("warning", message));
        refreshedTask.timeline.push(this.createEvent("needs_manual_action", "warning", message, target.platform));
        continue;
      }

      const status = await adapter.getPublishStatus(target.remoteId, {
        accountId: target.account.id,
        credential: resolvePlatformCredential(target.account) ?? undefined,
      });
      const nextTargetStatus = this.mapRemoteStateToTargetStatus(status.state);
      const message = `${target.platform} 远程状态同步完成：${status.detail ?? status.state}`;

      target.status = nextTargetStatus;
      target.remoteId = status.remoteId ?? target.remoteId;
      target.url = status.url ?? target.url;
      target.issues = [...target.issues, ...(status.issues ?? [])];
      target.logs.push(this.createLog(nextTargetStatus === "failed" ? "error" : "info", message));
      target.completedAt = nextTargetStatus === "running" ? undefined : this.createTimestamp();
      refreshedTask.timeline.push(
        this.createEvent(
          nextTargetStatus === "failed"
            ? "failed"
            : nextTargetStatus === "needs_manual_action"
              ? "needs_manual_action"
              : nextTargetStatus === "succeeded"
                ? "succeeded"
                : "running",
          nextTargetStatus === "failed" ? "error" : nextTargetStatus === "needs_manual_action" ? "warning" : "info",
          message,
          target.platform,
        ),
      );
    }

    refreshedTask.status = this.summarizeTaskStatus(refreshedTask.targets);
    refreshedTask.updatedAt = this.createTimestamp();
    const savedTask = await upsertTask(refreshedTask);

    return this.mapTaskForResponse(savedTask ?? refreshedTask);
  }
}
