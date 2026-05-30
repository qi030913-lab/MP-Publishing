import { adapterRegistry } from "@mp-publishing/adapter-core";
import {
  createPublishAttempt,
  createPublishTargetWorker,
  ensureRuntimeReady,
  getWorkerStatus,
  markPublishTargetFailed,
  markPublishTargetNeedsManualAction,
  markPublishTargetNeedsRetry,
  markPublishTargetSucceeded,
  startPublishTarget,
  updateWorkerStatus,
  type PublishQueueJobData,
} from "@mp-publishing/task-runtime";
import type { Job } from "bullmq";

function createTimestamp() {
  return new Date().toISOString();
}

async function markWorkerWorking(taskId?: string) {
  await updateWorkerStatus({
    status: "working",
    currentTaskId: taskId,
    lastHeartbeatAt: createTimestamp(),
  });
}

async function markWorkerIdle(lastProcessedTaskId?: string) {
  const currentWorker = await getWorkerStatus();
  await updateWorkerStatus({
    status: "idle",
    currentTaskId: undefined,
    lastHeartbeatAt: createTimestamp(),
    lastProcessedTaskId: lastProcessedTaskId ?? currentWorker.lastProcessedTaskId,
    processedCount: lastProcessedTaskId ? currentWorker.processedCount + 1 : currentWorker.processedCount,
  });
}

async function markWorkerOffline() {
  await updateWorkerStatus({
    status: "offline",
    currentTaskId: undefined,
    lastHeartbeatAt: createTimestamp(),
  });
}

async function processPublishTarget(job: Job<PublishQueueJobData>) {
  await markWorkerWorking(job.data.taskId);

  const context = await startPublishTarget(job.data.targetId);
  if (!context) {
    await markWorkerIdle(job.data.taskId);
    return;
  }

  await createPublishAttempt(context.targetId, context.attemptCount);

  if (!context.account || context.account.health === "needs-login") {
    await markPublishTargetNeedsManualAction(
      context.targetId,
      `${context.platform} 需要人工登录后才能继续发布。`,
    );
    await markWorkerIdle(context.taskId);
    return;
  }

  if (context.account.health === "expiring" && context.attemptCount === 1) {
    await markPublishTargetNeedsRetry(
      context.targetId,
      `${context.platform} 账号凭证接近过期，建议执行重试。`,
    );
    await markWorkerIdle(context.taskId);
    return;
  }

  const adapter = adapterRegistry.get(context.platform);

  try {
    if (context.mode === "simulate") {
      const result = await adapter.simulatePublish({
        accountId: context.account.id,
        document: context.document,
        dryRun: true,
      });

      if (!result.ok) {
        await markPublishTargetFailed(context.targetId, `${context.platform} 模拟发布校验未通过。`, result.issues);
      } else {
        await markPublishTargetSucceeded(context.targetId, {
          screenshots: result.screenshots,
          issues: result.issues,
        });
      }
    } else {
      const result = await adapter.publish({
        accountId: context.account.id,
        document: context.document,
        dryRun: true,
      });

      if (!result.ok) {
        await markPublishTargetFailed(context.targetId, `${context.platform} mock 发布失败。`, result.issues);
      } else {
        await markPublishTargetSucceeded(context.targetId, {
          remoteId: result.remoteId,
          url: result.url,
          issues: result.issues,
        });
      }
    }
  } catch (error) {
    await markPublishTargetFailed(
      context.targetId,
      error instanceof Error ? error.message : "未知发布执行异常。",
    );
  } finally {
    await markWorkerIdle(context.taskId);
  }
}

function registerShutdownHooks(worker: ReturnType<typeof createPublishTargetWorker>) {
  const shutdown = () => {
    void worker.close().finally(() => {
      void markWorkerOffline().finally(() => process.exit(0));
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function bootstrap() {
  await ensureRuntimeReady();
  await updateWorkerStatus({
    status: "idle",
    lastHeartbeatAt: createTimestamp(),
  });

  const worker = createPublishTargetWorker(processPublishTarget);
  worker.on("drained", () => {
    void markWorkerIdle();
  });
  worker.on("failed", (job, error) => {
    if (!job) {
      return;
    }

    void markPublishTargetFailed(
      job.data.targetId,
      error instanceof Error ? error.message : "BullMQ job failed.",
    );
  });

  registerShutdownHooks(worker);
  console.log("publish worker is listening for BullMQ jobs");
}

void bootstrap();
