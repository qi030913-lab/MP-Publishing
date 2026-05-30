import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlatformName, ValidationIssue } from "@mp-publishing/platform-sdk";

export type PlatformAccountHealth = "healthy" | "expiring" | "needs-login";
export type PublishTaskMode = "simulate" | "mock-publish";
export type PublishTaskTargetStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "needs_retry"
  | "failed"
  | "needs_manual_action";
export type PublishTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "needs_manual_action";

export type PlatformAccountRecord = {
  id: string;
  platform: PlatformName;
  displayName: string;
  handle: string;
  authMode: "official-api" | "cookie-session" | "hybrid";
  health: PlatformAccountHealth;
  lastCheckedAt: string;
};

export type PublishTaskLog = {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type PublishTaskTargetRecord = {
  platform: PlatformName;
  account: PlatformAccountRecord | null;
  status: PublishTaskTargetStatus;
  attemptCount: number;
  remoteId?: string;
  url?: string;
  screenshots?: string[];
  issues: ValidationIssue[];
  logs: PublishTaskLog[];
  startedAt?: string;
  completedAt?: string;
};

export type PublishTaskRecord = {
  id: string;
  mode: PublishTaskMode;
  status: PublishTaskStatus;
  documentTitle: string;
  createdAt: string;
  updatedAt: string;
  targets: PublishTaskTargetRecord[];
};

export type WorkerRuntimeStatus = {
  name: string;
  status: "idle" | "working" | "offline";
  lastHeartbeatAt?: string;
  lastProcessedTaskId?: string;
  currentTaskId?: string;
  processedCount: number;
};

type RuntimeState = {
  accounts: PlatformAccountRecord[];
  tasks: PublishTaskRecord[];
  worker: WorkerRuntimeStatus;
};

const defaultAccounts: PlatformAccountRecord[] = [
  {
    id: "acct_wechat_main",
    platform: "wechat",
    displayName: "公众号主账号",
    handle: "创作者实验室",
    authMode: "official-api",
    health: "healthy",
    lastCheckedAt: "2026-05-29T22:00:00+08:00",
  },
  {
    id: "acct_zhihu_main",
    platform: "zhihu",
    displayName: "知乎创作账号",
    handle: "内容系统设计",
    authMode: "official-api",
    health: "healthy",
    lastCheckedAt: "2026-05-29T22:05:00+08:00",
  },
  {
    id: "acct_bilibili_main",
    platform: "bilibili",
    displayName: "B站视频号",
    handle: "效率创作手记",
    authMode: "hybrid",
    health: "expiring",
    lastCheckedAt: "2026-05-29T21:55:00+08:00",
  },
  {
    id: "acct_xhs_main",
    platform: "xiaohongshu",
    displayName: "小红书笔记号",
    handle: "创作效率观察",
    authMode: "hybrid",
    health: "healthy",
    lastCheckedAt: "2026-05-29T21:50:00+08:00",
  },
];

function createDefaultWorkerState(): WorkerRuntimeStatus {
  return {
    name: "publish-worker",
    status: "offline",
    processedCount: 0,
  };
}

function findWorkspaceRoot(startDir: string) {
  let currentDir = startDir;

  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return startDir;
    }

    currentDir = parentDir;
  }
}

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findWorkspaceRoot(process.cwd()) || findWorkspaceRoot(packageDir);
const runtimeRoot = path.join(repoRoot, ".runtime");
const stateFilePath = path.join(runtimeRoot, "publish-state.json");

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDefaultState(): RuntimeState {
  return {
    accounts: cloneState(defaultAccounts),
    tasks: [],
    worker: createDefaultWorkerState(),
  };
}

function normalizeRuntimeState(input: Partial<RuntimeState> | null | undefined): RuntimeState {
  const fallback = createDefaultState();

  return {
    accounts: Array.isArray(input?.accounts) ? input.accounts : fallback.accounts,
    tasks: Array.isArray(input?.tasks) ? input.tasks : fallback.tasks,
    worker: {
      ...fallback.worker,
      ...(input?.worker ?? {}),
    },
  };
}

async function ensureRuntimeRoot() {
  await mkdir(runtimeRoot, { recursive: true });
}

export async function loadRuntimeState() {
  await ensureRuntimeRoot();

  try {
    const raw = await readFile(stateFilePath, "utf8");
    return normalizeRuntimeState(JSON.parse(raw) as Partial<RuntimeState>);
  } catch {
    const initialState = createDefaultState();
    await saveRuntimeState(initialState);
    return initialState;
  }
}

export async function saveRuntimeState(state: RuntimeState) {
  await ensureRuntimeRoot();
  await writeFile(stateFilePath, JSON.stringify(state, null, 2), "utf8");
}

export async function resetRuntimeState() {
  const initialState = createDefaultState();
  await saveRuntimeState(initialState);
  return initialState;
}

export async function listAccounts() {
  const state = await loadRuntimeState();
  return state.accounts;
}

export async function findAccountById(accountId: string) {
  const state = await loadRuntimeState();
  return state.accounts.find((account) => account.id === accountId) ?? null;
}

export async function updateAccount(
  accountId: string,
  patch: Partial<PlatformAccountRecord>,
) {
  const state = await loadRuntimeState();
  const account = state.accounts.find((item) => item.id === accountId) ?? null;
  if (!account) {
    return null;
  }

  Object.assign(account, patch);
  await saveRuntimeState(state);
  return account;
}

export async function listTasks() {
  const state = await loadRuntimeState();
  return state.tasks;
}

export async function getWorkerStatus() {
  const state = await loadRuntimeState();
  return state.worker;
}

export async function updateWorkerStatus(
  patch: Partial<WorkerRuntimeStatus>,
) {
  const state = await loadRuntimeState();
  state.worker = {
    ...state.worker,
    ...patch,
  };
  await saveRuntimeState(state);
  return state.worker;
}

export async function findTaskById(taskId: string) {
  const state = await loadRuntimeState();
  return state.tasks.find((task) => task.id === taskId) ?? null;
}

export async function upsertTask(task: PublishTaskRecord) {
  const state = await loadRuntimeState();
  const index = state.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    state.tasks[index] = task;
  } else {
    state.tasks.unshift(task);
  }

  await saveRuntimeState(state);
  return task;
}

export async function updateTask(taskId: string, updater: (task: PublishTaskRecord) => PublishTaskRecord) {
  const state = await loadRuntimeState();
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) {
    return null;
  }

  state.tasks[index] = updater(state.tasks[index]);
  await saveRuntimeState(state);
  return state.tasks[index];
}

export async function replaceTasks(tasks: PublishTaskRecord[]) {
  const state = await loadRuntimeState();
  state.tasks = tasks;
  await saveRuntimeState(state);
  return tasks;
}

export async function getRuntimeStats() {
  const state = await loadRuntimeState();
  const queuedCount = state.tasks.reduce(
    (count, task) => count + task.targets.filter((target) => target.status === "queued").length,
    0,
  );
  const runningCount = state.tasks.reduce(
    (count, task) => count + task.targets.filter((target) => target.status === "running").length,
    0,
  );
  const needsRetryCount = state.tasks.reduce(
    (count, task) => count + task.targets.filter((target) => target.status === "needs_retry").length,
    0,
  );
  const manualActionCount = state.tasks.reduce(
    (count, task) =>
      count + task.targets.filter((target) => target.status === "needs_manual_action").length,
    0,
  );
  const succeededCount = state.tasks.reduce(
    (count, task) => count + task.targets.filter((target) => target.status === "succeeded").length,
    0,
  );

  return {
    worker: state.worker,
    tasks: {
      total: state.tasks.length,
      queuedCount,
      runningCount,
      needsRetryCount,
      manualActionCount,
      succeededCount,
    },
  };
}
