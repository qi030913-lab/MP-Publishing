import type { DraftDocument, PreviewResult } from "./types";

const draftKey = "mp-publishing:draft";
const previewKey = "mp-publishing:previews";
const activeTaskKey = "mp-publishing:active-task-id";

export const defaultDraft: DraftDocument = {
  title: "一篇内容，如何高效同步到多个创作平台",
  summary: "统一内容模型是多平台发布系统的第一块基石。",
  body: [
    "很多创作者都会把同一篇内容同步到公众号、知乎、B站和小红书，但每个平台都要重新处理标题、导语、摘要和段落风格，发布链路也各不相同。",
    "这类重复劳动不只是浪费时间，更容易让优质内容在最后一步掉线：有的平台太书面，有的平台标签不对，有的平台结构不适合快速阅读。",
    "理想的工具应该让创作者先专注表达，再由系统接手格式适配、语气调整、风险提示和发布编排。",
  ].join("\n\n"),
  tags: ["内容运营", "创作者工具", "多平台发布"],
  platforms: ["wechat", "zhihu", "bilibili", "xiaohongshu"],
  toneMode: "platform-optimized",
  preserveOriginal: false,
};

function canUseStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function loadDraft(): DraftDocument {
  if (!canUseStorage()) {
    return defaultDraft;
  }

  try {
    const raw = window.localStorage.getItem(draftKey);
    return raw ? { ...defaultDraft, ...JSON.parse(raw) } : defaultDraft;
  } catch {
    return defaultDraft;
  }
}

export function saveDraft(draft: DraftDocument) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(draftKey, JSON.stringify(draft));
}

export function loadPreviews(): PreviewResult[] {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(previewKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePreviews(previews: PreviewResult[]) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(previewKey, JSON.stringify(previews));
}

export function loadActiveTaskId() {
  if (!canUseStorage()) {
    return null;
  }

  return window.localStorage.getItem(activeTaskKey);
}

export function saveActiveTaskId(taskId: string) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(activeTaskKey, taskId);
}
