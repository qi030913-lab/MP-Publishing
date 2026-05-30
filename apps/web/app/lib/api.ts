import type {
  AccountSummary,
  DraftDocument,
  PlatformAccount,
  PlatformCapability,
  PlatformName,
  PreviewResult,
  PublishTaskDetail,
  PublishTaskSummary,
  RuntimeStatus,
} from "./types";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export function listPlatforms() {
  return request<{ capabilities: PlatformCapability[]; items: Array<{ platform: PlatformName; summary: string }> }>(
    "/platforms",
  );
}

export function generatePreview(draft: DraftDocument) {
  return request<{ previews: PreviewResult[] }>("/preview", {
    method: "POST",
    body: JSON.stringify({
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      tags: draft.tags,
      platforms: draft.platforms,
      toneMode: draft.toneMode,
      preserveOriginal: draft.preserveOriginal,
    }),
  });
}

export function listAccounts() {
  return request<{ items: PlatformAccount[]; summary: AccountSummary }>("/accounts");
}

export function runPublishAction(mode: "simulate" | "mock" | "real", draft: DraftDocument, accountIds: string[]) {
  return request<PublishTaskDetail>(`/publish/${mode}`, {
    method: "POST",
    body: JSON.stringify({
      document: {
        title: draft.title,
        summary: draft.summary,
        body: draft.body,
        tags: draft.tags,
      },
      platforms: draft.platforms,
      accountIds,
      toneMode: draft.toneMode,
      preserveOriginal: draft.preserveOriginal,
    }),
  });
}

export function listTasks() {
  return request<{ items: PublishTaskSummary[] }>("/publish/tasks");
}

export function getTask(taskId: string) {
  return request<PublishTaskDetail>(`/publish/tasks/${taskId}`);
}

export function retryTask(taskId: string, platform?: PlatformName) {
  return request<PublishTaskDetail>(`/publish/tasks/${taskId}/retry`, {
    method: "POST",
    body: JSON.stringify({ platform }),
  });
}

export function syncTask(taskId: string, platform?: PlatformName) {
  return request<PublishTaskDetail>(`/publish/tasks/${taskId}/sync`, {
    method: "POST",
    body: JSON.stringify({ platform }),
  });
}

export function accountAction(accountId: string, action: "check" | "refresh" | "mark-needs-login") {
  return request<PlatformAccount>(`/accounts/${accountId}/${action}`, {
    method: "POST",
  });
}

export function getRuntimeStatus() {
  return request<RuntimeStatus>("/runtime/status");
}
