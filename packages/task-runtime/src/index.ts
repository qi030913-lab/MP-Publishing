import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Queue, Worker, type Job } from "bullmq";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";

import type { CanonicalDocument } from "@mp-publishing/content-model";
import type {
  PlatformCredential,
  PlatformName,
  ValidationIssue,
} from "@mp-publishing/platform-sdk";

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

function loadWorkspaceEnv() {
  const envPath = path.join(findWorkspaceRoot(process.cwd()), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");

    process.env[key] ??= value;
  }
}

loadWorkspaceEnv();

export type PlatformAccountHealth = "healthy" | "expiring" | "needs-login";
export type PublishTaskMode = "simulate" | "mock-publish" | "real-publish";
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
  credentialRef?: string;
  credentialStatus: "unbound" | "missing" | "configured";
  lastCheckedAt: string;
};

export type PublishTaskLog = {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type PublishTaskEvent = {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  stage:
    | "created"
    | "queued"
    | "running"
    | "needs_retry"
    | "needs_manual_action"
    | "retrying"
    | "succeeded"
    | "failed";
  message: string;
  platform?: PlatformName;
};

export type PublishTaskTargetRecord = {
  id?: string;
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
  documentId?: string;
  versionId?: string;
  createdAt: string;
  updatedAt: string;
  timeline: PublishTaskEvent[];
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

export type PublishQueueJobData = {
  taskId: string;
  targetId: string;
  platform: PlatformName;
  attemptCount: number;
};

export type PublishTargetProcessingContext = {
  taskId: string;
  targetId: string;
  mode: PublishTaskMode;
  platform: PlatformName;
  attemptCount: number;
  account: PlatformAccountRecord | null;
  credential: PlatformCredential | null;
  document: CanonicalDocument;
};

const defaultWorkspaceId = "workspace_demo";
const defaultUserId = "user_demo";
const defaultWorkerId = "publish-worker";
const defaultDatabaseUrl =
  "postgresql://mp_publishing:mp_publishing@localhost:5432/mp_publishing?schema=public";
const publishQueueName = process.env.PUBLISH_QUEUE_NAME ?? "mp-publishing-publish-targets";

const defaultAccounts: PlatformAccountRecord[] = [
  {
    id: "acct_wechat_main",
    platform: "wechat",
    displayName: "公众号主账号",
    handle: "创作者实验室",
    authMode: "official-api",
    health: "healthy",
    credentialRef: process.env.WECHAT_OFFICIAL_ACCOUNT_CREDENTIAL_REF ?? "env:WECHAT_OFFICIAL_ACCOUNT",
    credentialStatus: "unbound",
    lastCheckedAt: "2026-05-29T22:00:00+08:00",
  },
  {
    id: "acct_zhihu_main",
    platform: "zhihu",
    displayName: "知乎创作账号",
    handle: "内容系统设计",
    authMode: "official-api",
    health: "healthy",
    credentialRef: process.env.ZHIHU_CREDENTIAL_REF ?? "env:ZHIHU",
    credentialStatus: "unbound",
    lastCheckedAt: "2026-05-29T22:05:00+08:00",
  },
  {
    id: "acct_bilibili_main",
    platform: "bilibili",
    displayName: "B站视频号",
    handle: "效率创作手记",
    authMode: "hybrid",
    health: "expiring",
    credentialRef: process.env.BILIBILI_CREDENTIAL_REF ?? "env:BILIBILI",
    credentialStatus: "unbound",
    lastCheckedAt: "2026-05-29T21:55:00+08:00",
  },
  {
    id: "acct_xhs_main",
    platform: "xiaohongshu",
    displayName: "小红书笔记号",
    handle: "创作效率观察",
    authMode: "hybrid",
    health: "healthy",
    credentialRef: process.env.XIAOHONGSHU_CREDENTIAL_REF ?? "env:XIAOHONGSHU",
    credentialStatus: "unbound",
    lastCheckedAt: "2026-05-29T21:50:00+08:00",
  },
];

const globalForPrisma = globalThis as unknown as {
  __mpPublishingPrisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.__mpPublishingPrisma ??
  new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL ?? defaultDatabaseUrl),
    log: process.env.PRISMA_QUERY_LOG === "true" ? ["query", "warn", "error"] : ["warn", "error"],
  });

globalForPrisma.__mpPublishingPrisma = prisma;

function createTimestamp() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readJsonArray<T>(value: Prisma.JsonValue | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function readJsonObject<T>(value: Prisma.JsonValue | null | undefined): T {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
}

function readEnvValue(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readCredentialEnvPrefix(credentialRef?: string) {
  if (!credentialRef?.startsWith("env:")) {
    return null;
  }

  const prefix = credentialRef.slice("env:".length).trim();
  return prefix.length > 0 ? prefix : null;
}

function hasUsableCredential(credential: PlatformCredential) {
  if (credential.authMode === "official-api") {
    return Boolean(credential.accessToken || (credential.appId && credential.appSecret));
  }

  if (credential.authMode === "cookie-session") {
    return Boolean(credential.cookies || credential.storageStateJson);
  }

  return Boolean(
    credential.accessToken ||
      (credential.appId && credential.appSecret) ||
      credential.cookies ||
      credential.storageStateJson,
  );
}

export function resolvePlatformCredential(account: PlatformAccountRecord | null): PlatformCredential | null {
  const prefix = readCredentialEnvPrefix(account?.credentialRef);
  if (!account || !account.credentialRef || !prefix) {
    return null;
  }

  const credential: PlatformCredential = {
    accountId: account.id,
    platform: account.platform,
    credentialRef: account.credentialRef,
    authMode: account.authMode,
    appId: readEnvValue(`${prefix}_APP_ID`),
    appSecret: readEnvValue(`${prefix}_APP_SECRET`),
    accessToken: readEnvValue(`${prefix}_ACCESS_TOKEN`),
    refreshToken: readEnvValue(`${prefix}_REFRESH_TOKEN`),
    cookies: readEnvValue(`${prefix}_COOKIES`),
    storageStateJson: readEnvValue(`${prefix}_STORAGE_STATE_JSON`),
    expiresAt: readEnvValue(`${prefix}_EXPIRES_AT`),
  };

  return hasUsableCredential(credential) ? credential : null;
}

function getCredentialStatus(account: {
  id: string;
  platform: string;
  authMode: string;
  credentialRef?: string | null;
}): PlatformAccountRecord["credentialStatus"] {
  if (!account.credentialRef) {
    return "unbound";
  }

  return resolvePlatformCredential({
    id: account.id,
    platform: account.platform as PlatformName,
    displayName: "",
    handle: "",
    authMode: account.authMode as PlatformAccountRecord["authMode"],
    health: "healthy",
    credentialRef: account.credentialRef,
    credentialStatus: "missing",
    lastCheckedAt: createTimestamp(),
  })
    ? "configured"
    : "missing";
}

function createLog(level: PublishTaskLog["level"], message: string): PublishTaskLog {
  return {
    id: createId("log"),
    timestamp: createTimestamp(),
    level,
    message,
  };
}

function createEvent(
  stage: PublishTaskEvent["stage"],
  level: PublishTaskEvent["level"],
  message: string,
  platform?: PublishTaskEvent["platform"],
): PublishTaskEvent {
  return {
    id: createId("evt"),
    timestamp: createTimestamp(),
    level,
    stage,
    message,
    platform,
  };
}

function summarizeTaskStatus(targets: Array<{ status: string }>): PublishTaskStatus {
  const statuses = targets.map((target) => target.status);

  if (statuses.some((status) => status === "running" || status === "queued")) {
    return "running";
  }

  if (statuses.some((status) => status === "needs_manual_action")) {
    return "needs_manual_action";
  }

  if (statuses.length > 0 && statuses.every((status) => status === "succeeded")) {
    return "succeeded";
  }

  if (statuses.length > 0 && statuses.every((status) => status === "failed")) {
    return "failed";
  }

  return "partial";
}

function createRedisConnection() {
  const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6380");

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    db: redisUrl.pathname.length > 1 ? Number(redisUrl.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}

function mapAccount(account: {
  id: string;
  platform: string;
  displayName: string;
  handle: string;
  authMode: string;
  health: string;
  credentialRef: string | null;
  lastCheckedAt: Date;
}): PlatformAccountRecord {
  return {
    id: account.id,
    platform: account.platform as PlatformName,
    displayName: account.displayName,
    handle: account.handle,
    authMode: account.authMode as PlatformAccountRecord["authMode"],
    health: account.health as PlatformAccountHealth,
    credentialRef: account.credentialRef ?? undefined,
    credentialStatus: getCredentialStatus(account),
    lastCheckedAt: account.lastCheckedAt.toISOString(),
  };
}

function mapTarget(target: {
  id: string;
  platform: string;
  account: {
    id: string;
    platform: string;
    displayName: string;
    handle: string;
    authMode: string;
    health: string;
    credentialRef: string | null;
    lastCheckedAt: Date;
  } | null;
  status: string;
  attemptCount: number;
  remoteId: string | null;
  url: string | null;
  screenshots: Prisma.JsonValue;
  issues: Prisma.JsonValue;
  logs: Prisma.JsonValue;
  startedAt: Date | null;
  completedAt: Date | null;
}): PublishTaskTargetRecord {
  return {
    id: target.id,
    platform: target.platform as PlatformName,
    account: target.account ? mapAccount(target.account) : null,
    status: target.status as PublishTaskTargetStatus,
    attemptCount: target.attemptCount,
    remoteId: target.remoteId ?? undefined,
    url: target.url ?? undefined,
    screenshots: readJsonArray<string>(target.screenshots),
    issues: readJsonArray<ValidationIssue>(target.issues),
    logs: readJsonArray<PublishTaskLog>(target.logs),
    startedAt: target.startedAt?.toISOString(),
    completedAt: target.completedAt?.toISOString(),
  };
}

function mapTask(task: {
  id: string;
  mode: string;
  status: string;
  documentTitle: string;
  documentId: string | null;
  versionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  timeline: Prisma.JsonValue;
  targets: Array<Parameters<typeof mapTarget>[0]>;
}): PublishTaskRecord {
  return {
    id: task.id,
    mode: task.mode as PublishTaskMode,
    status: task.status as PublishTaskStatus,
    documentTitle: task.documentTitle,
    documentId: task.documentId ?? undefined,
    versionId: task.versionId ?? undefined,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    timeline: readJsonArray<PublishTaskEvent>(task.timeline),
    targets: task.targets.map(mapTarget),
  };
}

async function recalculateTaskStatus(taskId: string) {
  const targets = await prisma.publishTarget.findMany({
    where: { jobId: taskId },
    select: { status: true },
  });
  const status = summarizeTaskStatus(targets);

  await prisma.publishJob.update({
    where: { id: taskId },
    data: { status },
  });

  return status;
}

async function appendTargetLogAndTaskEvent(
  targetId: string,
  log: PublishTaskLog,
  event: PublishTaskEvent,
  patch: {
    status?: PublishTaskTargetStatus;
    remoteId?: string;
    url?: string;
    screenshots?: string[];
    issues?: ValidationIssue[];
    startedAt?: Date | null;
    completedAt?: Date | null;
  } = {},
) {
  const target = await prisma.publishTarget.findUnique({
    where: { id: targetId },
    include: { job: true },
  });

  if (!target) {
    return null;
  }

  const logs = [...readJsonArray<PublishTaskLog>(target.logs), log];
  const timeline = [...readJsonArray<PublishTaskEvent>(target.job.timeline), event];

  await prisma.$transaction([
    prisma.publishTarget.update({
      where: { id: targetId },
      data: {
        status: patch.status ?? target.status,
        remoteId: patch.remoteId,
        url: patch.url,
        screenshots: toJson(patch.screenshots ?? readJsonArray<string>(target.screenshots)),
        issues: toJson(patch.issues ?? readJsonArray<ValidationIssue>(target.issues)),
        logs: toJson(logs),
        startedAt: patch.startedAt === undefined ? target.startedAt : patch.startedAt,
        completedAt: patch.completedAt === undefined ? target.completedAt : patch.completedAt,
      },
    }),
    prisma.publishJob.update({
      where: { id: target.jobId },
      data: {
        timeline: toJson(timeline),
      },
    }),
  ]);

  await recalculateTaskStatus(target.jobId);
  return findTaskById(target.jobId);
}

export async function ensureRuntimeReady() {
  await prisma.user.upsert({
    where: { id: defaultUserId },
    update: {},
    create: {
      id: defaultUserId,
      email: "demo@mp-publishing.local",
      name: "Demo Creator",
    },
  });

  await prisma.workspace.upsert({
    where: { id: defaultWorkspaceId },
    update: {},
    create: {
      id: defaultWorkspaceId,
      name: "默认工作区",
      ownerId: defaultUserId,
    },
  });

  for (const account of defaultAccounts) {
    await prisma.platformAccount.upsert({
      where: { id: account.id },
      update: {
        credentialRef: account.credentialRef,
      },
      create: {
        id: account.id,
        workspaceId: defaultWorkspaceId,
        platform: account.platform,
        displayName: account.displayName,
        handle: account.handle,
        authMode: account.authMode,
        health: account.health,
        credentialRef: account.credentialRef,
        lastCheckedAt: new Date(account.lastCheckedAt),
      },
    });
  }

  await prisma.workerRuntime.upsert({
    where: { id: defaultWorkerId },
    update: {},
    create: {
      id: defaultWorkerId,
      name: defaultWorkerId,
      status: "offline",
      processedCount: 0,
    },
  });
}

export async function createContentSnapshot(document: CanonicalDocument) {
  await ensureRuntimeReady();
  const documentId = document.id || createId("doc");
  const versionId = createId("ver");

  const contentDocument = await prisma.contentDocument.upsert({
    where: { id: documentId },
    update: {
      title: document.title,
      summary: document.summary,
      metadata: toJson(document.metadata),
    },
    create: {
      id: documentId,
      workspaceId: defaultWorkspaceId,
      title: document.title,
      summary: document.summary,
      metadata: toJson(document.metadata),
    },
  });

  const latestVersion = await prisma.contentVersion.findFirst({
    where: { documentId: contentDocument.id },
    orderBy: { versionNo: "desc" },
    select: { versionNo: true },
  });

  const version = await prisma.contentVersion.create({
    data: {
      id: versionId,
      documentId: contentDocument.id,
      versionNo: (latestVersion?.versionNo ?? 0) + 1,
      body: toJson({
        blocks: document.blocks,
        assets: document.assets,
      }),
      plainText: document.blocks
        .flatMap((block) => {
          if (block.text) {
            return [block.text];
          }

          if (block.items) {
            return block.items;
          }

          return [];
        })
        .join("\n\n"),
      tags: toJson(document.metadata.topics),
    },
  });

  return {
    documentId: contentDocument.id,
    versionId: version.id,
  };
}

export async function resetRuntimeState() {
  await ensureRuntimeReady();
  await prisma.$transaction([
    prisma.auditLog.deleteMany({ where: { workspaceId: defaultWorkspaceId } }),
    prisma.publishAttempt.deleteMany({}),
    prisma.publishTarget.deleteMany({}),
    prisma.publishJob.deleteMany({ where: { workspaceId: defaultWorkspaceId } }),
    prisma.contentVersion.deleteMany({}),
    prisma.contentDocument.deleteMany({ where: { workspaceId: defaultWorkspaceId } }),
    prisma.workerRuntime.update({
      where: { id: defaultWorkerId },
      data: {
        status: "offline",
        currentTaskId: null,
        lastProcessedTaskId: null,
        lastHeartbeatAt: null,
        processedCount: 0,
      },
    }),
  ]);

  return getRuntimeStats();
}

export async function listAccounts() {
  await ensureRuntimeReady();
  const accounts = await prisma.platformAccount.findMany({
    where: { workspaceId: defaultWorkspaceId },
    orderBy: [{ platform: "asc" }, { displayName: "asc" }],
  });

  return accounts.map(mapAccount);
}

export async function findAccountById(accountId: string) {
  await ensureRuntimeReady();
  const account = await prisma.platformAccount.findUnique({
    where: { id: accountId },
  });

  return account ? mapAccount(account) : null;
}

export async function updateAccount(
  accountId: string,
  patch: Partial<PlatformAccountRecord>,
) {
  await ensureRuntimeReady();
  const account = await prisma.platformAccount.update({
    where: { id: accountId },
    data: {
      displayName: patch.displayName,
      handle: patch.handle,
      authMode: patch.authMode,
      health: patch.health,
      credentialRef: patch.credentialRef,
      lastCheckedAt: patch.lastCheckedAt ? new Date(patch.lastCheckedAt) : undefined,
    },
  });

  return mapAccount(account);
}

export async function listTasks() {
  await ensureRuntimeReady();
  const tasks = await prisma.publishJob.findMany({
    where: { workspaceId: defaultWorkspaceId },
    include: {
      targets: {
        include: { account: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return tasks.map(mapTask);
}

export async function findTaskById(taskId: string) {
  await ensureRuntimeReady();
  const task = await prisma.publishJob.findUnique({
    where: { id: taskId },
    include: {
      targets: {
        include: { account: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return task ? mapTask(task) : null;
}

export async function upsertTask(task: PublishTaskRecord) {
  await ensureRuntimeReady();
  const existingTask = await prisma.publishJob.findUnique({
    where: { id: task.id },
    include: { targets: true },
  });

  if (!existingTask) {
    await prisma.publishJob.create({
      data: {
        id: task.id,
        workspaceId: defaultWorkspaceId,
        documentId: task.documentId,
        versionId: task.versionId,
        mode: task.mode,
        status: task.status,
        documentTitle: task.documentTitle,
        timeline: toJson(task.timeline),
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
        targets: {
          create: task.targets.map((target) => ({
            id: target.id ?? createId("target"),
            platform: target.platform,
            accountId: target.account?.id,
            status: target.status,
            attemptCount: target.attemptCount,
            remoteId: target.remoteId,
            url: target.url,
            screenshots: toJson(target.screenshots ?? []),
            issues: toJson(target.issues),
            logs: toJson(target.logs),
            startedAt: target.startedAt ? new Date(target.startedAt) : undefined,
            completedAt: target.completedAt ? new Date(target.completedAt) : undefined,
          })),
        },
      },
    });

    return findTaskById(task.id);
  }

  await prisma.publishJob.update({
    where: { id: task.id },
    data: {
      status: task.status,
      documentTitle: task.documentTitle,
      documentId: task.documentId,
      versionId: task.versionId,
      timeline: toJson(task.timeline),
      updatedAt: new Date(task.updatedAt),
    },
  });

  for (const target of task.targets) {
    const existingTarget = existingTask.targets.find((item) => item.id === target.id || item.platform === target.platform);
    if (!existingTarget) {
      await prisma.publishTarget.create({
        data: {
          id: target.id ?? createId("target"),
          jobId: task.id,
          platform: target.platform,
          accountId: target.account?.id,
          status: target.status,
          attemptCount: target.attemptCount,
          screenshots: toJson(target.screenshots ?? []),
          issues: toJson(target.issues),
          logs: toJson(target.logs),
        },
      });
      continue;
    }

    await prisma.publishTarget.update({
      where: { id: existingTarget.id },
      data: {
        accountId: target.account?.id,
        status: target.status,
        attemptCount: target.attemptCount,
        remoteId: target.remoteId,
        url: target.url,
        screenshots: toJson(target.screenshots ?? []),
        issues: toJson(target.issues),
        logs: toJson(target.logs),
        startedAt: target.startedAt ? new Date(target.startedAt) : null,
        completedAt: target.completedAt ? new Date(target.completedAt) : null,
      },
    });
  }

  await recalculateTaskStatus(task.id);
  return findTaskById(task.id);
}

export async function replaceTasks(tasks: PublishTaskRecord[]) {
  await resetRuntimeState();
  const savedTasks = [];

  for (const task of tasks) {
    const savedTask = await upsertTask(task);
    if (savedTask) {
      savedTasks.push(savedTask);
    }
  }

  return savedTasks;
}

export async function getWorkerStatus() {
  await ensureRuntimeReady();
  const worker = await prisma.workerRuntime.findUnique({
    where: { id: defaultWorkerId },
  });

  return {
    name: worker?.name ?? defaultWorkerId,
    status: (worker?.status ?? "offline") as WorkerRuntimeStatus["status"],
    lastHeartbeatAt: worker?.lastHeartbeatAt?.toISOString(),
    lastProcessedTaskId: worker?.lastProcessedTaskId ?? undefined,
    currentTaskId: worker?.currentTaskId ?? undefined,
    processedCount: worker?.processedCount ?? 0,
  };
}

export async function updateWorkerStatus(
  patch: Partial<WorkerRuntimeStatus>,
) {
  await ensureRuntimeReady();
  const hasCurrentTaskPatch = Object.prototype.hasOwnProperty.call(patch, "currentTaskId");
  const hasLastProcessedPatch = Object.prototype.hasOwnProperty.call(patch, "lastProcessedTaskId");
  const worker = await prisma.workerRuntime.update({
    where: { id: defaultWorkerId },
    data: {
      status: patch.status,
      lastHeartbeatAt: patch.lastHeartbeatAt ? new Date(patch.lastHeartbeatAt) : undefined,
      lastProcessedTaskId: hasLastProcessedPatch ? patch.lastProcessedTaskId ?? null : undefined,
      currentTaskId: hasCurrentTaskPatch ? patch.currentTaskId ?? null : undefined,
      processedCount: patch.processedCount,
    },
  });

  return {
    name: worker.name,
    status: worker.status as WorkerRuntimeStatus["status"],
    lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString(),
    lastProcessedTaskId: worker.lastProcessedTaskId ?? undefined,
    currentTaskId: worker.currentTaskId ?? undefined,
    processedCount: worker.processedCount,
  };
}

export function createPublishQueue() {
  return new Queue<PublishQueueJobData>(publishQueueName, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });
}

export async function enqueueTaskTargets(taskId: string, platform?: PlatformName) {
  await ensureRuntimeReady();
  const targets = await prisma.publishTarget.findMany({
    where: {
      jobId: taskId,
      status: "queued",
      ...(platform ? { platform } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  if (targets.length === 0) {
    return 0;
  }

  const queue = createPublishQueue();
  try {
    await queue.addBulk(
      targets.map((target) => ({
        name: "process-publish-target",
        data: {
          taskId,
          targetId: target.id,
          platform: target.platform as PlatformName,
          attemptCount: target.attemptCount,
        },
        opts: {
          jobId: `${target.id}-${target.attemptCount}`,
        },
      })),
    );
  } finally {
    await queue.close();
  }

  return targets.length;
}

export function createPublishTargetWorker(
  processor: (job: Job<PublishQueueJobData>) => Promise<void>,
) {
  return new Worker<PublishQueueJobData>(publishQueueName, processor, {
    connection: createRedisConnection(),
    concurrency: Number(process.env.PUBLISH_WORKER_CONCURRENCY ?? 4),
  });
}

export async function getPublishQueueStats() {
  const queue = createPublishQueue();
  try {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  } finally {
    await queue.close();
  }
}

export async function startPublishTarget(targetId: string): Promise<PublishTargetProcessingContext | null> {
  await ensureRuntimeReady();
  const target = await prisma.publishTarget.findUnique({
    where: { id: targetId },
    include: {
      account: true,
      job: {
        include: {
          version: {
            include: {
              document: true,
            },
          },
        },
      },
    },
  });

  if (!target || !target.job.version) {
    return null;
  }

  await appendTargetLogAndTaskEvent(
    target.id,
    createLog("info", `${target.platform} 已进入 BullMQ worker 执行。`),
    createEvent("running", "info", `${target.platform} 已进入 BullMQ worker 执行。`, target.platform as PlatformName),
    {
      status: "running",
      startedAt: new Date(),
      completedAt: null,
    },
  );

  const body = readJsonObject<{ blocks?: CanonicalDocument["blocks"]; assets?: CanonicalDocument["assets"] }>(
    target.job.version.body,
  );

  const account = target.account ? mapAccount(target.account) : null;

  return {
    taskId: target.jobId,
    targetId: target.id,
    mode: target.job.mode as PublishTaskMode,
    platform: target.platform as PlatformName,
    attemptCount: target.attemptCount,
    account,
    credential: resolvePlatformCredential(account),
    document: {
      id: target.job.documentId ?? target.job.version.document.id,
      title: target.job.version.document.title,
      summary: target.job.version.document.summary ?? undefined,
      blocks: body.blocks ?? [],
      assets: body.assets ?? [],
      metadata: readJsonObject<CanonicalDocument["metadata"]>(target.job.version.document.metadata),
    },
  };
}

export async function createPublishAttempt(targetId: string, attemptNo: number) {
  await prisma.publishAttempt.upsert({
    where: {
      targetId_attemptNo: {
        targetId,
        attemptNo,
      },
    },
    update: {
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      error: null,
      result: undefined,
    },
    create: {
      id: createId("attempt"),
      targetId,
      attemptNo,
      status: "running",
    },
  });
}

export async function markPublishTargetSucceeded(
  targetId: string,
  result: {
    remoteId?: string;
    url?: string;
    screenshots?: string[];
    issues: ValidationIssue[];
  },
) {
  const target = await prisma.publishTarget.findUnique({
    where: { id: targetId },
    select: { attemptCount: true, platform: true },
  });

  if (!target) {
    return null;
  }

  await prisma.publishAttempt.update({
    where: {
      targetId_attemptNo: {
        targetId,
        attemptNo: target.attemptCount,
      },
    },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      result: toJson(result),
    },
  });

  return appendTargetLogAndTaskEvent(
    targetId,
    createLog("info", `${target.platform} 任务执行完成。`),
    createEvent("succeeded", "info", `${target.platform} 任务执行完成。`, target.platform as PlatformName),
    {
      status: "succeeded",
      remoteId: result.remoteId,
      url: result.url,
      screenshots: result.screenshots ?? [],
      issues: result.issues,
      completedAt: new Date(),
    },
  );
}

export async function markPublishTargetFailed(targetId: string, error: string, issues: ValidationIssue[] = []) {
  const target = await prisma.publishTarget.findUnique({
    where: { id: targetId },
    select: { attemptCount: true, platform: true },
  });

  if (!target) {
    return null;
  }

  await prisma.publishAttempt.update({
    where: {
      targetId_attemptNo: {
        targetId,
        attemptNo: target.attemptCount,
      },
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      error,
    },
  });

  return appendTargetLogAndTaskEvent(
    targetId,
    createLog("error", `${target.platform} 执行失败：${error}`),
    createEvent("failed", "error", `${target.platform} 执行失败：${error}`, target.platform as PlatformName),
    {
      status: "failed",
      issues,
      completedAt: new Date(),
    },
  );
}

export async function markPublishTargetNeedsRetry(targetId: string, message: string) {
  const target = await prisma.publishTarget.findUnique({
    where: { id: targetId },
    select: { attemptCount: true, platform: true },
  });

  if (!target) {
    return null;
  }

  await prisma.publishAttempt.update({
    where: {
      targetId_attemptNo: {
        targetId,
        attemptNo: target.attemptCount,
      },
    },
    data: {
      status: "needs_retry",
      completedAt: new Date(),
      error: message,
    },
  });

  return appendTargetLogAndTaskEvent(
    targetId,
    createLog("warning", message),
    createEvent("needs_retry", "warning", message, target.platform as PlatformName),
    {
      status: "needs_retry",
      completedAt: new Date(),
    },
  );
}

export async function markPublishTargetNeedsManualAction(targetId: string, message: string) {
  const target = await prisma.publishTarget.findUnique({
    where: { id: targetId },
    select: { attemptCount: true, platform: true },
  });

  if (!target) {
    return null;
  }

  await prisma.publishAttempt.update({
    where: {
      targetId_attemptNo: {
        targetId,
        attemptNo: target.attemptCount,
      },
    },
    data: {
      status: "needs_manual_action",
      completedAt: new Date(),
      error: message,
    },
  });

  return appendTargetLogAndTaskEvent(
    targetId,
    createLog("warning", message),
    createEvent("needs_manual_action", "warning", message, target.platform as PlatformName),
    {
      status: "needs_manual_action",
      completedAt: new Date(),
    },
  );
}

export async function getRuntimeStats() {
  await ensureRuntimeReady();
  const [worker, queue, total, queuedCount, runningCount, needsRetryCount, manualActionCount, succeededCount] =
    await Promise.all([
      getWorkerStatus(),
      getPublishQueueStats(),
      prisma.publishJob.count({ where: { workspaceId: defaultWorkspaceId } }),
      prisma.publishTarget.count({ where: { status: "queued" } }),
      prisma.publishTarget.count({ where: { status: "running" } }),
      prisma.publishTarget.count({ where: { status: "needs_retry" } }),
      prisma.publishTarget.count({ where: { status: "needs_manual_action" } }),
      prisma.publishTarget.count({ where: { status: "succeeded" } }),
    ]);

  return {
    worker,
    queue,
    tasks: {
      total,
      queuedCount,
      runningCount,
      needsRetryCount,
      manualActionCount,
      succeededCount,
    },
  };
}
