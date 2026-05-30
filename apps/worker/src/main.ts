import {
  getWorkerStatus,
  listAccounts,
  listTasks,
  type PublishTaskLog,
  type PublishTaskRecord,
  type PublishTaskTargetRecord,
  upsertTask,
  updateWorkerStatus,
} from "@mp-publishing/task-runtime";

const tickIntervalMs = 1200;
const completionDelayMs = 1500;

function createTimestamp() {
  return new Date().toISOString();
}

function createLog(level: PublishTaskLog["level"], message: string): PublishTaskLog {
  return {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    timestamp: createTimestamp(),
    level,
    message,
  };
}

function summarizeTaskStatus(targets: PublishTaskTargetRecord[]): PublishTaskRecord["status"] {
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

async function processTask(task: PublishTaskRecord) {
  const accounts = await listAccounts();
  let changed = false;

  task.targets = task.targets.map((target) => {
    const nextAccount = target.account
      ? accounts.find((account) => account.id === target.account?.id) ?? target.account
      : null;

    return {
      ...target,
      account: nextAccount,
    };
  });

  task.targets.forEach((target) => {
    if (target.status === "queued") {
      target.status = "running";
      target.startedAt = createTimestamp();
      target.logs.push(createLog("info", `${target.platform} 已进入 worker 执行队列。`));
      changed = true;
      return;
    }

    if (target.status !== "running" || !target.startedAt) {
      return;
    }

    const elapsed = Date.now() - new Date(target.startedAt).getTime();
    if (elapsed < completionDelayMs) {
      return;
    }

    if (!target.account || target.account.health === "needs-login") {
      target.status = "needs_manual_action";
      target.logs.push(createLog("warning", `${target.platform} 需要人工登录后才能继续发布。`));
      changed = true;
      return;
    }

    if (target.account.health === "expiring" && target.attemptCount === 1) {
      target.status = "needs_retry";
      target.logs.push(createLog("warning", `${target.platform} 账号凭证接近过期，建议执行重试。`));
      changed = true;
      return;
    }

    target.status = "succeeded";
    target.completedAt = createTimestamp();
    target.logs.push(createLog("info", `${target.platform} 任务执行完成。`));
    changed = true;
  });

  if (!changed) {
    return false;
  }

  task.status = summarizeTaskStatus(task.targets);
  task.updatedAt = createTimestamp();
  await upsertTask(task);
  return true;
}

async function workOnce() {
  const tasks = await listTasks();
  let handledTaskId: string | undefined;
  let workerStatus: "idle" | "working" = "idle";

  for (const task of tasks) {
    const hasActiveTarget = task.targets.some(
      (target) => target.status === "queued" || target.status === "running",
    );

    if (hasActiveTarget) {
      workerStatus = "working";
      handledTaskId = task.id;
    }

    const changed = await processTask(task);
    if (changed) {
      handledTaskId = task.id;
    }
  }

  const currentWorker = await getWorkerStatus();
  await updateWorkerStatus({
    status: workerStatus,
    lastHeartbeatAt: createTimestamp(),
    currentTaskId: workerStatus === "working" ? handledTaskId : undefined,
    lastProcessedTaskId: handledTaskId ?? currentWorker.lastProcessedTaskId,
    processedCount: handledTaskId ? currentWorker.processedCount + 1 : currentWorker.processedCount,
  });
}

async function markWorkerOffline() {
  await updateWorkerStatus({
    status: "offline",
    currentTaskId: undefined,
    lastHeartbeatAt: createTimestamp(),
  });
}

function registerShutdownHooks() {
  const shutdown = () => {
    void markWorkerOffline().finally(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function bootstrap() {
  registerShutdownHooks();
  await updateWorkerStatus({
    status: "idle",
    lastHeartbeatAt: createTimestamp(),
  });
  console.log("worker bootstrap");
  await workOnce();
  setInterval(() => {
    void workOnce();
  }, tickIntervalMs);
}

void bootstrap();
