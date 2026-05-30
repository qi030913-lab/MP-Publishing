"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BookOpen,
  Bot,
  CheckCircle2,
  CircleAlert,
  Eye,
  History,
  LayoutTemplate,
  ListRestart,
  LoaderCircle,
  MonitorSmartphone,
  MessageSquare,
  Orbit,
  Radio,
  RefreshCcw,
  ScrollText,
  Send,
  Sparkles,
  SquarePen,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type PlatformName = "wechat" | "zhihu" | "bilibili" | "xiaohongshu";
type ToneMode = "keep" | "platform-optimized";

type ValidationIssue = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

type PreviewResult = {
  platform: PlatformName;
  title: string;
  summary?: string;
  body: string;
  hashtags: string[];
  warnings: ValidationIssue[];
};

type PlatformCapability = {
  platform: PlatformName;
  titleMaxLength?: number;
  summaryMaxLength?: number;
  supportedBlocks: string[];
  supportsHtml: boolean;
  supportsMarkdown: boolean;
  supportsHashtags: boolean;
  supportsScheduling: boolean;
  publishMode: "official-api" | "automation" | "hybrid";
};

type PlatformAccount = {
  id: string;
  platform: PlatformName;
  displayName: string;
  handle: string;
  authMode: "official-api" | "cookie-session" | "hybrid";
  health: "healthy" | "expiring" | "needs-login";
  lastCheckedAt: string;
};

type TaskResult = {
  platform: PlatformName;
  account: PlatformAccount | null;
  ok: boolean;
  screenshots?: string[];
  remoteId?: string;
  url?: string;
  issues: ValidationIssue[];
  status: "queued" | "running" | "succeeded" | "needs_retry" | "failed" | "needs_manual_action";
  attemptCount: number;
  startedAt?: string;
  completedAt?: string;
  logs: Array<{
    id: string;
    timestamp: string;
    level: "info" | "warning" | "error";
    message: string;
  }>;
};

type PublishTaskDetail = {
  id: string;
  mode: "simulate" | "mock-publish";
  overallStatus: "ready" | "needs_attention" | "published" | "partial";
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "needs_manual_action";
  documentTitle: string;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{
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
  }>;
  results: TaskResult[];
};

type PublishTaskSummary = {
  id: string;
  mode: "simulate" | "mock-publish";
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "needs_manual_action";
  documentTitle: string;
  createdAt: string;
  updatedAt: string;
  targetCount: number;
  issueCount: number;
};

type AccountSummary = {
  total: number;
  healthy: number;
  expiring: number;
  needsLogin: number;
};

type RuntimeStatus = {
  worker: {
    name: string;
    status: "idle" | "working" | "offline";
    lastHeartbeatAt?: string;
    lastProcessedTaskId?: string;
    currentTaskId?: string;
    processedCount: number;
  };
  tasks: {
    total: number;
    queuedCount: number;
    runningCount: number;
    needsRetryCount: number;
    manualActionCount: number;
    succeededCount: number;
  };
};

const platformMeta: Record<
  PlatformName,
  {
    label: string;
    icon: typeof BookOpen;
    tint: string;
    description: string;
  }
> = {
  wechat: {
    label: "公众号",
    icon: LayoutTemplate,
    tint: "#2563eb",
    description: "图文排版、导语和信息密度都更偏编辑后台。",
  },
  zhihu: {
    label: "知乎",
    icon: MessageSquare,
    tint: "#0f766e",
    description: "强调观点前置、论证结构和问题拆解。",
  },
  bilibili: {
    label: "B站",
    icon: Radio,
    tint: "#db2777",
    description: "更偏口语表达、节奏感和用户互动氛围。",
  },
  xiaohongshu: {
    label: "小红书",
    icon: Sparkles,
    tint: "#ea580c",
    description: "更强调标题吸引力、体验感和标签氛围。",
  },
};

const starterBody = [
  "很多创作者都会把同一篇内容同步到公众号、知乎、B站和小红书，但每个平台都要重新处理标题、导语、摘要和段落风格，发布链路也各不相同。",
  "这类重复劳动不只是浪费时间，更容易让优质内容在最后一步掉线：有的平台太书面，有的平台标签不对，有的平台结构不适合快速阅读。",
  "理想的工具应该让创作者先专注表达，再由系统接手格式适配、语气调整、风险提示和发布编排。",
].join("\n\n");

function extractPlainText(html: string) {
  return html
    .replace(/<\/h[1-6]>/g, "\n\n")
    .replace(/<p><\/p>/g, "\n")
    .replace(/<\/p>/g, "\n\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/ul>/g, "\n")
    .replace(/<\/ol>/g, "\n")
    .replace(/<li>/g, "- ")
    .replace(/<\/li>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTags(input: string) {
  return input
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatBody(body: string) {
  return body.split("\n").map((line, index) => (
    <p key={`${line}-${index}`} style={{ margin: 0 }}>
      {line || "\u00a0"}
    </p>
  ));
}

function statusLabel(status: PlatformAccount["health"]) {
  if (status === "healthy") return "健康";
  if (status === "expiring") return "即将过期";
  return "需要重新登录";
}

function reportStatusLabel(status: PublishTaskDetail["overallStatus"]) {
  if (status === "ready") return "可进入发布";
  if (status === "needs_attention") return "需要处理";
  if (status === "published") return "模拟发布成功";
  return "部分平台待确认";
}

function taskSummaryStatusLabel(status: PublishTaskSummary["status"]) {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "已失败";
  if (status === "needs_manual_action") return "待人工处理";
  return "部分完成";
}

function targetStatusLabel(status: TaskResult["status"]) {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "needs_manual_action") return "待人工处理";
  return "待重试";
}

function taskStatusLabel(status: PublishTaskDetail["status"]) {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "已失败";
  if (status === "needs_manual_action") return "待人工处理";
  return "部分完成";
}

function workerStatusLabel(status: RuntimeStatus["worker"]["status"]) {
  if (status === "working") return "执行中";
  if (status === "idle") return "空闲";
  return "离线";
}

function eventStageLabel(stage: PublishTaskDetail["timeline"][number]["stage"]) {
  if (stage === "created") return "创建";
  if (stage === "queued") return "入队";
  if (stage === "running") return "执行";
  if (stage === "needs_retry") return "待重试";
  if (stage === "needs_manual_action") return "待人工处理";
  if (stage === "retrying") return "重试";
  if (stage === "succeeded") return "完成";
  return "失败";
}

function createRuntimeFallback(): RuntimeStatus {
  return {
    worker: {
      name: "publish-worker",
      status: "offline",
      processedCount: 0,
    },
    tasks: {
      total: 0,
      queuedCount: 0,
      runningCount: 0,
      needsRetryCount: 0,
      manualActionCount: 0,
      succeededCount: 0,
    },
  };
}

function EmptyPreview() {
  return (
    <div className="empty-state">
      <div>
        <strong>先生成平台预览</strong>
        <p>填写标题和正文后，系统会在这里展示不同平台的适配结果、风险提示和发布建议。</p>
      </div>
    </div>
  );
}

function EmptyTasks() {
  return (
    <div className="empty-state report-empty">
      <div>
        <strong>暂无任务记录</strong>
        <p>运行模拟发布或 mock 一键发布后，这里会沉淀任务、日志和平台级状态，便于后续重试与追踪。</p>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [title, setTitle] = useState("一篇内容，如何高效同步到多个创作平台");
  const [summary, setSummary] = useState("统一内容模型是多平台发布系统的第一块基石。");
  const [tags, setTags] = useState("内容运营, 创作者工具, 多平台发布");
  const [toneMode, setToneMode] = useState<ToneMode>("platform-optimized");
  const [preserveOriginal, setPreserveOriginal] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformName[]>([
    "wechat",
    "zhihu",
    "bilibili",
    "xiaohongshu",
  ]);
  const [activePlatform, setActivePlatform] = useState<PlatformName>("wechat");
  const [previewResults, setPreviewResults] = useState<PreviewResult[]>([]);
  const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [accountSummary, setAccountSummary] = useState<AccountSummary>({
    total: 0,
    healthy: 0,
    expiring: 0,
    needsLogin: 0,
  });
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [taskSummaries, setTaskSummaries] = useState<PublishTaskSummary[]>([]);
  const [activeTask, setActiveTask] = useState<PublishTaskDetail | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isSimulationLoading, setIsSimulationLoading] = useState(false);
  const [isMockPublishLoading, setIsMockPublishLoading] = useState(false);
  const [isTasksLoading, setIsTasksLoading] = useState(false);
  const [isRuntimeLoading, setIsRuntimeLoading] = useState(false);
  const [isRetryingTaskId, setIsRetryingTaskId] = useState<string | null>(null);
  const [isAccountActionLoading, setIsAccountActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: `<p>${starterBody.split("\n\n").join("</p><p>")}</p>`,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "editor-surface",
      },
    },
  });

  const body = useMemo(() => extractPlainText(editor?.getHTML() ?? ""), [editor]);
  const runtimeSnapshot = runtimeStatus ?? createRuntimeFallback();
  const activePreview = previewResults.find((item) => item.platform === activePlatform);
  const currentCapability = capabilities.find((item) => item.platform === activePlatform);
  const selectedAccounts = accounts.filter((account) => selectedAccountIds.includes(account.id));
  const totalWarnings = previewResults.reduce((count, preview) => count + preview.warnings.length, 0);
  const totalIssues = activeTask?.results.reduce((count, item) => count + item.issues.length, 0) ?? 0;

  async function refreshTasks(selectTaskId?: string) {
    setIsTasksLoading(true);

    try {
      const response = await fetch("http://localhost:3001/publish/tasks");
      const payload = (await response.json()) as { items: PublishTaskSummary[] };
      setTaskSummaries(payload.items);

      const nextTaskId = selectTaskId ?? payload.items[0]?.id;
      if (nextTaskId) {
        const detailResponse = await fetch(`http://localhost:3001/publish/tasks/${nextTaskId}`);
        const detailPayload = (await detailResponse.json()) as PublishTaskDetail;
        setActiveTask(detailPayload);
      } else {
        setActiveTask(null);
      }
    } catch {
      setError("任务中心刷新失败，请确认 API 服务可用后重试。");
    } finally {
      setIsTasksLoading(false);
    }
  }

  async function refreshRuntimeStatus() {
    setIsRuntimeLoading(true);

    try {
      const response = await fetch("http://localhost:3001/runtime/status");
      const payload = (await response.json()) as RuntimeStatus;
      setRuntimeStatus(payload);
    } catch {
      setError("运行监控刷新失败，请确认 worker 与 API 服务可用。");
    } finally {
      setIsRuntimeLoading(false);
    }
  }

  async function refreshAccounts() {
    const response = await fetch("http://localhost:3001/accounts");
    const payload = (await response.json()) as { items: PlatformAccount[]; summary: AccountSummary };
    setAccounts(payload.items);
    setAccountSummary(payload.summary);
    setSelectedAccountIds((current) => {
      if (current.length === 0) {
        return payload.items.map((item) => item.id);
      }

      return current.filter((id) => payload.items.some((item) => item.id === id));
    });
  }

  useEffect(() => {
    async function bootstrapData() {
      try {
        const [platformResponse, accountResponse] = await Promise.all([
          fetch("http://localhost:3001/platforms"),
          fetch("http://localhost:3001/accounts"),
        ]);

        const platformPayload = (await platformResponse.json()) as { capabilities: PlatformCapability[] };
        const accountPayload = (await accountResponse.json()) as {
          items: PlatformAccount[];
          summary: AccountSummary;
        };

        setCapabilities(platformPayload.capabilities);
        setAccounts(accountPayload.items);
        setAccountSummary(accountPayload.summary);
        setSelectedAccountIds(accountPayload.items.map((item) => item.id));
        await Promise.all([refreshTasks(), refreshRuntimeStatus()]);
      } catch {
        setError("无法连接到本地 API，请确认 http://localhost:3001 已启动。");
      }
    }

    void bootstrapData();
  }, []);

  useEffect(() => {
    if (!activeTask) {
      return;
    }

    const hasLiveTargets = activeTask.results.some(
      (item) => item.status === "queued" || item.status === "running",
    );

    if (!hasLiveTargets) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshTasks(activeTask.id);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [activeTask]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshRuntimeStatus();
    }, 3000);

    return () => window.clearInterval(timer);
  }, []);

  async function openTask(taskId: string) {
    try {
      const response = await fetch(`http://localhost:3001/publish/tasks/${taskId}`);
      const payload = (await response.json()) as PublishTaskDetail;
      setActiveTask(payload);
    } catch {
      setError("读取任务详情失败，请稍后重试。");
    }
  }

  async function generatePreview() {
    setIsPreviewLoading(true);
    setError(null);

    try {
      const response = await fetch("http://localhost:3001/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          summary,
          body,
          tags: splitTags(tags),
          platforms: selectedPlatforms,
          toneMode,
          preserveOriginal,
        }),
      });

      if (!response.ok) {
        throw new Error("preview request failed");
      }

      const payload = (await response.json()) as { previews: PreviewResult[] };
      setPreviewResults(payload.previews);

      if (!payload.previews.some((item) => item.platform === activePlatform) && payload.previews[0]) {
        setActivePlatform(payload.previews[0].platform);
      }
    } catch {
      setError("生成预览失败，请确认 API 服务可用后重试。");
    } finally {
      setIsPreviewLoading(false);
    }
  }

  function togglePlatform(platform: PlatformName) {
    setSelectedPlatforms((current) => {
      if (current.includes(platform)) {
        const next = current.filter((item) => item !== platform);
        if (next.length > 0 && activePlatform === platform) {
          setActivePlatform(next[0]);
        }
        return next.length > 0 ? next : current;
      }

      return [...current, platform];
    });
  }

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((current) => {
      if (current.includes(accountId)) {
        const next = current.filter((item) => item !== accountId);
        return next.length > 0 ? next : current;
      }

      return [...current, accountId];
    });
  }

  async function runPublishAction(mode: "simulate" | "mock") {
    if (previewResults.length === 0) {
      setError("请先生成平台预览，再进入发布确认。");
      return;
    }

    if (mode === "simulate") {
      setIsSimulationLoading(true);
    } else {
      setIsMockPublishLoading(true);
    }

    setError(null);

    try {
      const response = await fetch(`http://localhost:3001/publish/${mode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          document: {
            title,
            summary,
            body,
            tags: splitTags(tags),
          },
          platforms: selectedPlatforms,
          accountIds: selectedAccountIds,
          toneMode,
          preserveOriginal,
        }),
      });

      if (!response.ok) {
        throw new Error("publish request failed");
      }

      const payload = (await response.json()) as PublishTaskDetail;
      setActiveTask(payload);
      await refreshTasks(payload.id);
    } catch {
      setError(mode === "simulate" ? "模拟发布失败，请稍后重试。" : "mock 发布失败，请稍后重试。");
    } finally {
      setIsSimulationLoading(false);
      setIsMockPublishLoading(false);
    }
  }

  async function retryTask(taskId: string, platform?: PlatformName) {
    setIsRetryingTaskId(taskId);
    setError(null);

    try {
      const response = await fetch(`http://localhost:3001/publish/tasks/${taskId}/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(platform ? { platform } : {}),
      });

      if (!response.ok) {
        throw new Error("retry request failed");
      }

      const payload = (await response.json()) as PublishTaskDetail;
      setActiveTask(payload);
      await refreshTasks(payload.id);
    } catch {
      setError("重试任务失败，请稍后重试。");
    } finally {
      setIsRetryingTaskId(null);
    }
  }

  async function runAccountAction(
    accountId: string,
    action: "check" | "refresh" | "mark-needs-login",
  ) {
    setIsAccountActionLoading(`${accountId}:${action}`);
    setError(null);

    try {
      const response = await fetch(`http://localhost:3001/accounts/${accountId}/${action}`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("account action failed");
      }

      await refreshAccounts();
      if (activeTask) {
        await refreshTasks(activeTask.id);
      }
    } catch {
      setError("账号操作失败，请稍后重试。");
    } finally {
      setIsAccountActionLoading(null);
    }
  }

  return (
    <main className="workspace-shell">
      <style jsx global>{`
        :root {
          color-scheme: dark;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background:
            radial-gradient(circle at top, rgba(30, 41, 59, 0.7), transparent 28%),
            linear-gradient(180deg, #0f172a 0%, #020617 100%);
          color: #e2e8f0;
        }

        button,
        input,
        textarea {
          font: inherit;
        }

        .editor-surface {
          min-height: 320px;
          outline: none;
          color: #e2e8f0;
          line-height: 1.8;
        }

        .editor-surface p {
          margin: 0 0 16px;
        }

        .editor-surface ul,
        .editor-surface ol {
          padding-left: 24px;
        }
      `}</style>

      <div className="workspace-grid">
        <section className="main-column">
          <div className="hero-band">
            <div>
              <p className="eyebrow">MP-Publishing</p>
              <h1>多平台创作、确认与任务中心工作台</h1>
              <p className="hero-copy">
                先写原稿，再自动适配平台风格；确认账号后运行模拟发布，所有结果会沉淀到任务中心，支持查看日志和逐平台重试。
              </p>
            </div>
            <div className="hero-metrics">
              <div className="metric-tile">
                <span>目标平台</span>
                <strong>{selectedPlatforms.length}</strong>
              </div>
              <div className="metric-tile">
                <span>已选账号</span>
                <strong>{selectedAccounts.length}</strong>
              </div>
              <div className="metric-tile">
                <span>任务问题</span>
                <strong>{totalIssues}</strong>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">Step 1</p>
                <h2>创作原稿</h2>
              </div>
              <div className="status-pill">
                <SquarePen size={16} />
                草稿编辑中
              </div>
            </div>

            <label className="field">
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="输入文章标题" />
            </label>

            <div className="field-grid">
              <label className="field">
                <span>摘要</span>
                <textarea
                  rows={3}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  placeholder="用两三句话概括内容重点"
                />
              </label>
              <label className="field">
                <span>主题标签</span>
                <textarea
                  rows={3}
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="多个标签用逗号分隔"
                />
              </label>
            </div>

            <div className="editor-panel">
              <div className="editor-toolbar">
                <div className="toolbar-group">
                  <button type="button" className="toolbar-button" onClick={() => editor?.chain().focus().toggleBold().run()} title="加粗">
                    B
                  </button>
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => editor?.chain().focus().toggleBulletList().run()}
                    title="列表"
                  >
                    •
                  </button>
                </div>
                <div className="toolbar-hint">正文会被自动转换为统一内容模型，再生成不同平台预览。</div>
              </div>
              <EditorContent editor={editor} />
            </div>

            <div className="control-stack">
              <div className="control-group">
                <span className="control-label">适配策略</span>
                <div className="segmented">
                  <button
                    type="button"
                    className={toneMode === "platform-optimized" ? "active" : ""}
                    onClick={() => setToneMode("platform-optimized")}
                  >
                    平台优化
                  </button>
                  <button type="button" className={toneMode === "keep" ? "active" : ""} onClick={() => setToneMode("keep")}>
                    保持原文
                  </button>
                </div>
              </div>

              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={preserveOriginal}
                  onChange={(event) => setPreserveOriginal(event.target.checked)}
                />
                <span>尽量保留原标题，不主动为平台裁剪标题</span>
              </label>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">Step 2</p>
                <h2>发布确认</h2>
              </div>
              <div className="status-pill subtle">
                <Bot size={16} />
                模拟优先
              </div>
            </div>

            <div className="platform-grid">
              {(Object.keys(platformMeta) as PlatformName[]).map((platform) => {
                const meta = platformMeta[platform];
                const Icon = meta.icon;
                const selected = selectedPlatforms.includes(platform);

                return (
                  <button
                    key={platform}
                    type="button"
                    className={`platform-chip ${selected ? "selected" : ""}`}
                    onClick={() => togglePlatform(platform)}
                  >
                    <div className="platform-icon" style={{ background: `${meta.tint}20`, color: meta.tint }}>
                      <Icon size={18} />
                    </div>
                    <div className="platform-copy">
                      <strong>{meta.label}</strong>
                      <span>{meta.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="account-list">
              {accounts.map((account) => {
                const selected = selectedAccountIds.includes(account.id);
                const meta = platformMeta[account.platform];

                return (
                  <div key={account.id} className={`account-card ${selected ? "selected" : ""}`}>
                    <label className="account-selector">
                      <input type="checkbox" checked={selected} onChange={() => toggleAccount(account.id)} />
                    </label>
                    <div className="account-copy">
                      <div className="account-line">
                        <strong>{account.displayName}</strong>
                        <span className={`account-health ${account.health}`}>{statusLabel(account.health)}</span>
                      </div>
                      <div className="account-line secondary">
                        <span>
                          {meta.label} / {account.handle}
                        </span>
                        <span>{account.authMode}</span>
                      </div>
                      <div className="account-actions">
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => runAccountAction(account.id, "check")}
                          disabled={isAccountActionLoading === `${account.id}:check`}
                        >
                          {isAccountActionLoading === `${account.id}:check` ? <LoaderCircle size={16} /> : <RefreshCcw size={16} />}
                          检查状态
                        </button>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => runAccountAction(account.id, "refresh")}
                          disabled={isAccountActionLoading === `${account.id}:refresh`}
                        >
                          {isAccountActionLoading === `${account.id}:refresh` ? <LoaderCircle size={16} /> : <CheckCircle2 size={16} />}
                          恢复凭证
                        </button>
                        <button
                          type="button"
                          className="secondary-button compact-button danger-button"
                          onClick={() => runAccountAction(account.id, "mark-needs-login")}
                          disabled={isAccountActionLoading === `${account.id}:mark-needs-login`}
                        >
                          {isAccountActionLoading === `${account.id}:mark-needs-login` ? (
                            <LoaderCircle size={16} />
                          ) : (
                            <CircleAlert size={16} />
                          )}
                          标记需登录
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="action-row">
              <button type="button" className="primary-button" onClick={generatePreview} disabled={isPreviewLoading}>
                <Eye size={16} />
                {isPreviewLoading ? "生成中..." : "更新平台预览"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => runPublishAction("simulate")}
                disabled={isSimulationLoading}
              >
                <WandSparkles size={16} />
                {isSimulationLoading ? "模拟发布中..." : "运行模拟发布"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => runPublishAction("mock")}
                disabled={isMockPublishLoading}
              >
                <Send size={16} />
                {isMockPublishLoading ? "提交中..." : "执行 mock 一键发布"}
              </button>
            </div>
          </div>
        </section>

        <section className="side-column">
          {error ? <div className="error-banner">{error}</div> : null}

          <div className="panel preview-shell">
            <div className="preview-header">
              <div>
                <p className="section-kicker">平台预览</p>
                <h2>查看适配差异</h2>
              </div>
              <div className="tab-row">
                {selectedPlatforms.map((platform) => {
                  const meta = platformMeta[platform];

                  return (
                    <button
                      key={platform}
                      type="button"
                      className={activePlatform === platform ? "active" : ""}
                      onClick={() => setActivePlatform(platform)}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {activePreview ? (
              <div className="preview-card">
                <div className="preview-card-header">
                  <div>
                    <h3>{activePreview.title}</h3>
                    <p>{activePreview.summary}</p>
                  </div>
                  <div className="preview-mode">
                    <Send size={16} />
                    {currentCapability?.publishMode ?? "preview"}
                  </div>
                </div>

                <div className="preview-body">{formatBody(activePreview.body)}</div>

                <div className="hashtag-row">
                  {activePreview.hashtags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>

                <div className="meta-grid">
                  <div>
                    <span className="meta-label">标题上限</span>
                    <strong>{currentCapability?.titleMaxLength ?? "不限"}</strong>
                  </div>
                  <div>
                    <span className="meta-label">支持 Markdown</span>
                    <strong>{currentCapability?.supportsMarkdown ? "是" : "否"}</strong>
                  </div>
                  <div>
                    <span className="meta-label">定时发布</span>
                    <strong>{currentCapability?.supportsScheduling ? "支持" : "暂不支持"}</strong>
                  </div>
                </div>

                <div className="warning-list">
                  {activePreview.warnings.length > 0 ? (
                    activePreview.warnings.map((warning) => (
                      <div key={`${warning.code}-${warning.message}`} className={`warning-item ${warning.severity}`}>
                        <span>{warning.severity.toUpperCase()}</span>
                        <p>{warning.message}</p>
                      </div>
                    ))
                  ) : (
                    <div className="warning-item info">
                      <span>READY</span>
                      <p>当前平台预览没有明显风险项，可以进入模拟发布或 mock 发布阶段。</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <EmptyPreview />
            )}
          </div>

          <div className="panel account-shell">
            <div className="panel-header">
              <div>
                <p className="section-kicker">Step 2.5</p>
                <h2>账号工作台</h2>
              </div>
              <button type="button" className="secondary-button compact-button" onClick={() => void refreshAccounts()}>
                <RefreshCcw size={16} />
                刷新账号
              </button>
            </div>

            <div className="account-summary-grid">
              <div className="metric-tile">
                <span>账号总数</span>
                <strong>{accountSummary.total}</strong>
              </div>
              <div className="metric-tile">
                <span>健康</span>
                <strong>{accountSummary.healthy}</strong>
              </div>
              <div className="metric-tile">
                <span>即将过期</span>
                <strong>{accountSummary.expiring}</strong>
              </div>
              <div className="metric-tile">
                <span>需重新登录</span>
                <strong>{accountSummary.needsLogin}</strong>
              </div>
            </div>

            <div className="warning-list compact">
              <div className="warning-item info">
                <span>FLOW</span>
                <p>先做健康检查，再恢复异常凭证；任务中心里的待人工处理和待重试会自动同步账号状态。</p>
              </div>
            </div>
          </div>

          <div className="panel task-shell">
            <div className="panel-header">
              <div>
                <p className="section-kicker">Step 3</p>
                <h2>发布任务中心</h2>
              </div>
              <div className="task-toolbar">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => void refreshRuntimeStatus()}
                  disabled={isRuntimeLoading}
                >
                  <Orbit size={16} />
                  {isRuntimeLoading ? "监控刷新中..." : "刷新监控"}
                </button>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => refreshTasks()}
                  disabled={isTasksLoading}
                >
                  <History size={16} />
                  {isTasksLoading ? "刷新中..." : "刷新任务"}
                </button>
              </div>
            </div>

            {runtimeStatus ? (
              <div className="runtime-panel">
                <div className="runtime-head">
                  <div>
                    <p className="section-kicker">Runtime</p>
                    <h3>Worker 运行监控</h3>
                  </div>
                  <div className={`status-pill ${runtimeSnapshot.worker.status === "offline" ? "warning" : "success"}`}>
                    <MonitorSmartphone size={16} />
                    {workerStatusLabel(runtimeSnapshot.worker.status)}
                  </div>
                </div>

                <div className="runtime-summary-grid">
                  <div className="metric-tile">
                    <span>任务总数</span>
                    <strong>{runtimeSnapshot.tasks.total}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>排队中</span>
                    <strong>{runtimeSnapshot.tasks.queuedCount}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>执行中</span>
                    <strong>{runtimeSnapshot.tasks.runningCount}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>待重试</span>
                    <strong>{runtimeSnapshot.tasks.needsRetryCount}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>待人工处理</span>
                    <strong>{runtimeSnapshot.tasks.manualActionCount}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>累计完成</span>
                    <strong>{runtimeSnapshot.tasks.succeededCount}</strong>
                  </div>
                </div>

                <div className="runtime-meta-grid">
                  <div>
                    <span className="meta-label">最近心跳</span>
                    <strong>
                      {runtimeSnapshot.worker.lastHeartbeatAt
                        ? new Date(runtimeSnapshot.worker.lastHeartbeatAt).toLocaleTimeString("zh-CN")
                        : "未上报"}
                    </strong>
                  </div>
                  <div>
                    <span className="meta-label">当前任务</span>
                    <strong>{runtimeSnapshot.worker.currentTaskId ?? "无"}</strong>
                  </div>
                  <div>
                    <span className="meta-label">最近处理</span>
                    <strong>{runtimeSnapshot.worker.lastProcessedTaskId ?? "暂无"}</strong>
                  </div>
                  <div>
                    <span className="meta-label">心跳计数</span>
                    <strong>{runtimeSnapshot.worker.processedCount}</strong>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTask ? (
              <div className="task-overview">
                <div className="task-header">
                  <div>
                    <strong>{activeTask.documentTitle}</strong>
                    <p>
                      {activeTask.mode === "simulate" ? "模拟发布任务" : "mock 一键发布任务"} / 最近更新时间 {new Date(
                        activeTask.updatedAt,
                      ).toLocaleString("zh-CN")}
                    </p>
                    <p>任务状态：{taskStatusLabel(activeTask.status)}</p>
                  </div>
                  <div
                    className={`status-pill ${
                      activeTask.overallStatus === "needs_attention" ? "warning" : "success"
                    }`}
                  >
                    <CheckCircle2 size={16} />
                    {reportStatusLabel(activeTask.overallStatus)}
                  </div>
                </div>

                <div className="task-actions">
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => retryTask(activeTask.id)}
                    disabled={isRetryingTaskId === activeTask.id}
                  >
                    <ListRestart size={16} />
                    {isRetryingTaskId === activeTask.id ? "重试中..." : "重试未完成项"}
                  </button>
                </div>

                <div className="task-result-list">
                  {activeTask.results.map((item) => {
                    const meta = platformMeta[item.platform];
                    return (
                      <article key={`${activeTask.id}-${item.platform}`} className="report-card">
                        <div className="report-card-head">
                          <div>
                            <strong>{meta.label}</strong>
                            <p>{item.account ? `${item.account.displayName} / ${item.account.handle}` : "未选择账号"}</p>
                          </div>
                          <span className={`report-pill ${item.ok ? "ok" : "attention"}`}>
                            {targetStatusLabel(item.status)}
                          </span>
                        </div>

                        <div className="task-meta-row">
                          <span>尝试次数：{item.attemptCount}</span>
                          {item.remoteId ? <span>回执 ID：{item.remoteId}</span> : null}
                          {item.startedAt ? (
                            <span>开始：{new Date(item.startedAt).toLocaleTimeString("zh-CN")}</span>
                          ) : null}
                          {item.completedAt ? (
                            <span>完成：{new Date(item.completedAt).toLocaleTimeString("zh-CN")}</span>
                          ) : null}
                        </div>

                        {item.url ? (
                          <a className="report-link" href={item.url} target="_blank" rel="noreferrer">
                            mock 发布回执：{item.url}
                          </a>
                        ) : null}

                        {item.screenshots?.length ? (
                          <div className="screenshot-list">
                            {item.screenshots.map((shot) => (
                              <span key={shot}>{shot}</span>
                            ))}
                          </div>
                        ) : null}

                        <div className="warning-list compact">
                          {item.issues.length > 0 ? (
                            item.issues.map((issue) => (
                              <div key={`${item.platform}-${issue.code}`} className={`warning-item ${issue.severity}`}>
                                <span>{issue.severity.toUpperCase()}</span>
                                <p>{issue.message}</p>
                              </div>
                            ))
                          ) : (
                            <div className="warning-item info">
                              <span>PASS</span>
                              <p>本平台当前无额外阻塞项，可继续进入真实发布链路。</p>
                            </div>
                          )}
                        </div>

                        <div className="log-list">
                          {item.logs.map((log) => (
                            <div key={log.id} className={`log-item ${log.level}`}>
                              <span>{new Date(log.timestamp).toLocaleTimeString("zh-CN")}</span>
                              <p>{log.message}</p>
                            </div>
                          ))}
                        </div>

                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => retryTask(activeTask.id, item.platform)}
                          disabled={isRetryingTaskId === activeTask.id}
                        >
                          <ListRestart size={16} />
                          重试 {meta.label}
                        </button>
                      </article>
                    );
                  })}
                </div>

                <div className="timeline-panel">
                  <div className="list-header">
                    <div className="list-title">
                      <ScrollText size={16} />
                      任务时间线
                    </div>
                  </div>

                  <div className="timeline-list">
                    {activeTask.timeline.map((event) => (
                      <div key={event.id} className={`timeline-item ${event.level}`}>
                        <div className="timeline-rail" />
                        <div className="timeline-content">
                          <div className="timeline-head">
                            <strong>{eventStageLabel(event.stage)}</strong>
                            <span>{new Date(event.timestamp).toLocaleTimeString("zh-CN")}</span>
                          </div>
                          <p>{event.message}</p>
                          {event.platform ? <span className="timeline-platform">{platformMeta[event.platform].label}</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyTasks />
            )}

            <div className="task-list-panel">
              <div className="list-header">
                <div className="list-title">
                  <ScrollText size={16} />
                  最近任务
                </div>
              </div>

              {taskSummaries.length > 0 ? (
                <div className="task-summary-list">
                  {taskSummaries.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className={`task-summary-card ${activeTask?.id === task.id ? "selected" : ""}`}
                      onClick={() => openTask(task.id)}
                    >
                      <div className="task-summary-head">
                        <strong>{task.documentTitle}</strong>
                        <span className={`summary-pill ${task.status}`}>{taskSummaryStatusLabel(task.status)}</span>
                      </div>
                      <div className="task-summary-meta">
                        <span>{task.mode === "simulate" ? "模拟发布" : "mock 发布"}</span>
                        <span>{task.targetCount} 平台</span>
                        <span>{task.issueCount} 问题</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyTasks />
              )}
            </div>
          </div>
        </section>
      </div>

      <style jsx>{`
        .workspace-shell {
          min-height: 100vh;
          padding: 28px;
        }

        .workspace-grid {
          max-width: 1560px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: minmax(0, 1.08fr) minmax(460px, 0.92fr);
          gap: 20px;
        }

        .main-column,
        .side-column {
          display: grid;
          gap: 20px;
          align-content: start;
        }

        .hero-band,
        .panel {
          background: rgba(15, 23, 42, 0.84);
          border: 1px solid rgba(148, 163, 184, 0.16);
          border-radius: 8px;
          box-shadow: 0 22px 70px rgba(2, 6, 23, 0.42);
        }

        .hero-band {
          padding: 28px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 20px;
        }

        .eyebrow,
        .section-kicker {
          margin: 0 0 10px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0;
          color: #94a3b8;
        }

        .hero-band h1,
        .panel h2 {
          margin: 0;
          font-size: 28px;
          line-height: 1.2;
        }

        .hero-copy {
          margin: 14px 0 0;
          color: #cbd5e1;
          line-height: 1.7;
          max-width: 760px;
        }

        .hero-metrics {
          display: grid;
          gap: 12px;
        }

        .metric-tile,
        .meta-grid > div {
          padding: 16px;
          border-radius: 8px;
          background: rgba(2, 6, 23, 0.34);
          border: 1px solid rgba(148, 163, 184, 0.14);
          display: grid;
          gap: 8px;
        }

        .metric-tile span,
        .field span,
        .control-label,
        .meta-label {
          font-size: 13px;
          color: #94a3b8;
        }

        .metric-tile strong {
          font-size: 24px;
        }

        .panel {
          padding: 24px;
        }

        .panel-header,
        .preview-header,
        .preview-card-header,
        .report-card-head,
        .task-header,
        .list-header,
        .runtime-head {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
        }

        .task-toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }

        .status-pill,
        .preview-mode,
        .report-pill,
        .summary-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 8px;
          white-space: nowrap;
          border: 1px solid rgba(37, 99, 235, 0.28);
          background: rgba(37, 99, 235, 0.12);
          color: #bfdbfe;
        }

        .status-pill.subtle {
          background: rgba(148, 163, 184, 0.1);
          border-color: rgba(148, 163, 184, 0.16);
          color: #cbd5e1;
        }

        .status-pill.warning,
        .report-pill.attention,
        .summary-pill.partial,
        .summary-pill.needs_manual_action {
          background: rgba(217, 119, 6, 0.14);
          border-color: rgba(217, 119, 6, 0.24);
          color: #fed7aa;
        }

        .status-pill.success,
        .report-pill.ok,
        .summary-pill.succeeded {
          background: rgba(22, 163, 74, 0.14);
          border-color: rgba(22, 163, 74, 0.24);
          color: #bbf7d0;
        }

        .summary-pill.failed {
          background: rgba(220, 38, 38, 0.16);
          border-color: rgba(220, 38, 38, 0.22);
          color: #fecaca;
        }

        .summary-pill.queued,
        .summary-pill.running {
          background: rgba(37, 99, 235, 0.14);
          border-color: rgba(37, 99, 235, 0.24);
          color: #bfdbfe;
        }

        .field-grid,
        .meta-grid,
        .platform-grid {
          display: grid;
          gap: 16px;
        }

        .field-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 18px;
        }

        .field {
          display: grid;
          gap: 8px;
          margin-top: 18px;
        }

        .field input,
        .field textarea {
          width: 100%;
          padding: 12px 14px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.22);
          background: rgba(15, 23, 42, 0.55);
          color: #e2e8f0;
          resize: vertical;
        }

        .editor-panel {
          margin-top: 18px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.18);
          overflow: hidden;
          background: rgba(2, 6, 23, 0.42);
        }

        .editor-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.14);
          color: #94a3b8;
        }

        .toolbar-group {
          display: inline-flex;
          gap: 8px;
        }

        .toolbar-button {
          width: 32px;
          height: 32px;
          border: 1px solid rgba(148, 163, 184, 0.22);
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.5);
          color: #e2e8f0;
          cursor: pointer;
        }

        .toolbar-hint {
          font-size: 13px;
          text-align: right;
        }

        .control-stack {
          display: grid;
          gap: 16px;
          margin-top: 18px;
        }

        .control-group {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }

        .segmented {
          display: inline-flex;
          padding: 4px;
          background: rgba(15, 23, 42, 0.78);
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.16);
        }

        .segmented button,
        .tab-row button,
        .primary-button,
        .secondary-button,
        .platform-chip,
        .task-summary-card {
          border: none;
          cursor: pointer;
        }

        .segmented button,
        .tab-row button {
          padding: 10px 14px;
          border-radius: 6px;
          background: transparent;
          color: #94a3b8;
        }

        .segmented button.active,
        .tab-row button.active {
          background: rgba(37, 99, 235, 0.16);
          color: #dbeafe;
        }

        .toggle-row {
          display: inline-flex;
          gap: 12px;
          align-items: center;
          color: #cbd5e1;
        }

        .platform-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 18px;
        }

        .platform-chip {
          display: grid;
          grid-template-columns: 44px minmax(0, 1fr);
          gap: 12px;
          padding: 16px;
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.78);
          border: 1px solid rgba(148, 163, 184, 0.14);
          text-align: left;
          color: #e2e8f0;
        }

        .platform-chip.selected {
          border-color: rgba(37, 99, 235, 0.4);
          background: rgba(15, 23, 42, 0.96);
        }

        .platform-icon {
          width: 44px;
          height: 44px;
          display: grid;
          place-items: center;
          border-radius: 8px;
        }

        .platform-copy {
          display: grid;
          gap: 6px;
        }

        .platform-copy span,
        .account-line.secondary,
        .report-card-head p,
        .preview-card-header p,
        .warning-item p,
        .empty-state p,
        .task-header p,
        .task-meta-row span,
        .task-summary-meta span,
        .log-item span {
          color: #94a3b8;
          font-size: 13px;
          line-height: 1.6;
          margin: 0;
        }

        .account-list,
        .warning-list,
        .task-result-list,
        .task-summary-list,
        .log-list {
          display: grid;
          gap: 12px;
        }

        .account-list {
          margin-top: 18px;
        }

        .account-card,
        .task-summary-card {
          display: grid;
          gap: 14px;
          padding: 14px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(15, 23, 42, 0.7);
        }

        .account-card {
          grid-template-columns: 20px minmax(0, 1fr);
        }

        .account-selector {
          display: grid;
          align-items: start;
        }

        .account-card.selected,
        .task-summary-card.selected {
          border-color: rgba(37, 99, 235, 0.4);
          background: rgba(15, 23, 42, 0.92);
        }

        .task-summary-card {
          text-align: left;
        }

        .task-summary-head,
        .task-summary-meta,
        .task-meta-row {
          display: flex;
          flex-wrap: wrap;
          justify-content: space-between;
          gap: 8px 12px;
        }

        .account-copy {
          display: grid;
          gap: 8px;
        }

        .account-line {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
        }

        .account-health {
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 12px;
          border: 1px solid rgba(148, 163, 184, 0.16);
        }

        .account-health.healthy {
          color: #bbf7d0;
          background: rgba(22, 163, 74, 0.14);
        }

        .account-health.expiring {
          color: #fed7aa;
          background: rgba(217, 119, 6, 0.14);
        }

        .account-health.needs-login {
          color: #fecaca;
          background: rgba(220, 38, 38, 0.14);
        }

        .action-row,
        .task-actions,
        .account-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }

        .action-row,
        .task-actions {
          margin-top: 20px;
        }

        .account-actions {
          margin-top: 4px;
        }

        .primary-button,
        .secondary-button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          border-radius: 8px;
          color: white;
        }

        .compact-button {
          padding: 10px 12px;
        }

        .primary-button {
          background: #2563eb;
        }

        .secondary-button {
          background: rgba(30, 41, 59, 0.92);
          border: 1px solid rgba(148, 163, 184, 0.2);
        }

        .danger-button {
          border-color: rgba(248, 113, 113, 0.22);
          color: #fecaca;
        }

        .primary-button:disabled,
        .secondary-button:disabled {
          opacity: 0.65;
          cursor: wait;
        }

        .error-banner {
          padding: 14px 16px;
          border-radius: 8px;
          background: rgba(127, 29, 29, 0.36);
          border: 1px solid rgba(248, 113, 113, 0.28);
          color: #fecaca;
        }

        .preview-shell,
        .task-shell,
        .account-shell {
          min-height: 340px;
        }

        .account-summary-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 22px;
        }

        .tab-row {
          display: inline-flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .preview-card,
        .task-overview,
        .runtime-panel {
          display: grid;
          gap: 22px;
          padding-top: 22px;
        }

        .runtime-head h3 {
          margin: 0;
          font-size: 20px;
        }

        .runtime-summary-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }

        .runtime-meta-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .runtime-meta-grid > div {
          padding: 16px;
          border-radius: 8px;
          background: rgba(2, 6, 23, 0.34);
          border: 1px solid rgba(148, 163, 184, 0.14);
          display: grid;
          gap: 8px;
        }

        .preview-card-header h3 {
          margin: 0;
          font-size: 24px;
        }

        .preview-body {
          display: grid;
          gap: 12px;
          color: #e2e8f0;
          line-height: 1.8;
          padding: 20px;
          border-radius: 8px;
          background: rgba(2, 6, 23, 0.34);
          border: 1px solid rgba(148, 163, 184, 0.12);
        }

        .hashtag-row,
        .screenshot-list {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .hashtag-row span,
        .screenshot-list span {
          padding: 8px 10px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.12);
          color: #bfdbfe;
          border: 1px solid rgba(37, 99, 235, 0.24);
        }

        .meta-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .warning-item {
          display: grid;
          grid-template-columns: 82px minmax(0, 1fr);
          gap: 14px;
          padding: 14px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(15, 23, 42, 0.7);
          align-items: start;
        }

        .warning-item span {
          display: inline-flex;
          justify-content: center;
          padding: 6px 8px;
          border-radius: 999px;
          font-size: 12px;
          background: rgba(148, 163, 184, 0.14);
          color: #cbd5e1;
        }

        .warning-item.info span {
          background: rgba(37, 99, 235, 0.16);
          color: #bfdbfe;
        }

        .warning-item.warning span {
          background: rgba(217, 119, 6, 0.16);
          color: #fed7aa;
        }

        .warning-item.error span,
        .log-item.error span {
          background: rgba(220, 38, 38, 0.16);
          color: #fecaca;
        }

        .report-card,
        .task-list-panel,
        .timeline-panel {
          padding: 18px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(15, 23, 42, 0.72);
          display: grid;
          gap: 14px;
        }

        .report-link {
          color: #93c5fd;
          text-decoration: none;
          word-break: break-all;
        }

        .log-list {
          padding-top: 8px;
          border-top: 1px solid rgba(148, 163, 184, 0.12);
        }

        .log-item {
          display: grid;
          grid-template-columns: 92px minmax(0, 1fr);
          gap: 12px;
          align-items: start;
        }

        .log-item p {
          margin: 0;
          line-height: 1.7;
        }

        .log-item.warning span {
          color: #fed7aa;
        }

        .task-list-panel {
          margin-top: 18px;
        }

        .list-title {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: #cbd5e1;
        }

        .timeline-list {
          display: grid;
          gap: 12px;
        }

        .timeline-item {
          display: grid;
          grid-template-columns: 12px minmax(0, 1fr);
          gap: 12px;
        }

        .timeline-rail {
          width: 12px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.32);
        }

        .timeline-item.warning .timeline-rail {
          background: rgba(217, 119, 6, 0.4);
        }

        .timeline-item.error .timeline-rail {
          background: rgba(220, 38, 38, 0.4);
        }

        .timeline-content {
          display: grid;
          gap: 8px;
          padding: 14px;
          border-radius: 8px;
          background: rgba(2, 6, 23, 0.34);
          border: 1px solid rgba(148, 163, 184, 0.14);
        }

        .timeline-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
        }

        .timeline-head span,
        .timeline-content p,
        .timeline-platform {
          color: #94a3b8;
          font-size: 13px;
          margin: 0;
        }

        .timeline-platform {
          display: inline-flex;
          width: fit-content;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.12);
          color: #bfdbfe;
          border: 1px solid rgba(37, 99, 235, 0.24);
        }

        .empty-state {
          min-height: 220px;
          display: grid;
          place-items: center;
          border-radius: 8px;
          border: 1px dashed rgba(148, 163, 184, 0.28);
          background: rgba(15, 23, 42, 0.38);
          padding: 24px;
          text-align: center;
        }

        .empty-state strong {
          display: block;
          margin-bottom: 8px;
        }

        .report-empty {
          min-height: 260px;
        }

        @media (max-width: 1240px) {
          .workspace-grid,
          .hero-band {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 760px) {
          .workspace-shell {
            padding: 16px;
          }

          .field-grid,
          .platform-grid,
          .meta-grid,
          .account-summary-grid,
          .runtime-summary-grid,
          .runtime-meta-grid {
            grid-template-columns: 1fr;
          }

          .panel-header,
          .preview-header,
          .preview-card-header,
          .control-group,
          .account-line,
          .report-card-head,
          .task-header,
          .timeline-head,
          .task-summary-head,
          .task-summary-meta,
          .task-meta-row,
          .log-item {
            display: grid;
          }

          .warning-item {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}
