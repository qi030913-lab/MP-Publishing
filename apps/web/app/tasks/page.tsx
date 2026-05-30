"use client";

import { RefreshCcw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getRuntimeStatus, getTask, listTasks, retryTask } from "../lib/api";
import { loadActiveTaskId, saveActiveTaskId } from "../lib/draft-store";
import { platformLabel } from "../lib/platforms";
import type { PlatformName, PublishTaskDetail, PublishTaskSummary, RuntimeStatus, TaskStatus } from "../lib/types";
import {
  EmptyState,
  LoadingInline,
  PageHeader,
  PlatformBadge,
  StageRail,
  StatusBadge,
  SummaryTile,
  taskStatusLabel,
  taskStatusTone,
} from "../components/ui";

type FilterMode = "all" | "running" | "attention" | "succeeded";

function matchesFilter(task: PublishTaskSummary, filter: FilterMode) {
  if (filter === "all") return true;
  if (filter === "running") return task.status === "running" || task.status === "queued";
  if (filter === "succeeded") return task.status === "succeeded";

  return (
    task.status === "partial" ||
    task.status === "needs_manual_action" ||
    task.status === "failed" ||
    task.targetStatuses.some((target) => target.status === "needs_manual_action" || target.status === "needs_retry")
  );
}

function formatTime(value?: string) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN");
}

function runtimeFallback(): RuntimeStatus {
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

export default function TasksPage() {
  const [tasks, setTasks] = useState<PublishTaskSummary[]>([]);
  const [activeTask, setActiveTask] = useState<PublishTaskDetail | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus>(runtimeFallback);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return tasks
      .filter((task) => matchesFilter(task, filter))
      .filter((task) =>
        normalizedQuery
          ? task.documentTitle.toLowerCase().includes(normalizedQuery) || task.id.toLowerCase().includes(normalizedQuery)
          : true,
      );
  }, [filter, query, tasks]);

  async function refresh(selectTaskId?: string) {
    setIsLoading(true);
    setError(null);

    try {
      const [taskPayload, runtimePayload] = await Promise.all([listTasks(), getRuntimeStatus()]);
      setTasks(taskPayload.items);
      setRuntime(runtimePayload);

      const nextTaskId = selectTaskId ?? activeTask?.id ?? loadActiveTaskId() ?? taskPayload.items[0]?.id;
      if (nextTaskId) {
        const detail = await getTask(nextTaskId);
        setActiveTask(detail);
        saveActiveTaskId(detail.id);
      } else {
        setActiveTask(null);
      }
    } catch {
      setError("任务中心刷新失败，请确认 API 和 worker 已启动。");
    } finally {
      setIsLoading(false);
    }
  }

  async function openTask(taskId: string) {
    setError(null);
    try {
      const detail = await getTask(taskId);
      setActiveTask(detail);
      saveActiveTaskId(detail.id);
    } catch {
      setError("读取任务详情失败。");
    }
  }

  async function handleRetry(taskId: string, platform?: PlatformName) {
    const retryKey = `${taskId}-${platform ?? "all"}`;
    setRetryingKey(retryKey);
    setError(null);

    try {
      const detail = await retryTask(taskId, platform);
      setActiveTask(detail);
      await refresh(detail.id);
    } catch {
      setError("重试任务失败。");
    } finally {
      setRetryingKey(null);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!activeTask?.results.some((result) => result.status === "queued" || result.status === "running")) {
      return;
    }

    const timer = window.setInterval(() => {
      void refresh(activeTask.id);
    }, 1800);

    return () => window.clearInterval(timer);
  }, [activeTask]);

  return (
    <div className="page-shell">
      <PageHeader
        kicker="Tasks"
        title="任务中心"
        description="查看模拟发布、mock 发布、重试和人工处理状态，worker 心跳也集中在这里。"
        actions={
          <button className="secondary-button" type="button" onClick={() => refresh()} disabled={isLoading}>
            {isLoading ? <LoadingInline label="刷新中" /> : <RefreshCcw size={18} />}
            刷新
          </button>
        }
      />
      <StageRail active="tasks" />

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="panel">
        <div className="summary-grid">
          <SummaryTile label="任务总数" value={runtime.tasks.total} />
          <SummaryTile label="执行中" value={runtime.tasks.queuedCount + runtime.tasks.runningCount} />
          <SummaryTile label="待处理" value={runtime.tasks.needsRetryCount + runtime.tasks.manualActionCount} />
        </div>
        <div className="runtime-grid" style={{ marginTop: 12 }}>
          <div className="capability-item">
            <span>Worker</span>
            <strong>{runtime.worker.status === "working" ? "执行中" : runtime.worker.status === "idle" ? "空闲" : "离线"}</strong>
          </div>
          <div className="capability-item">
            <span>最近心跳</span>
            <strong>{formatTime(runtime.worker.lastHeartbeatAt)}</strong>
          </div>
        </div>
      </section>

      {tasks.length === 0 ? (
        <EmptyState
          title="暂无任务记录"
          description="在发布确认页发起模拟发布或 mock 发布后，任务会出现在这里。"
          actionHref="/publish"
          actionLabel="去发布确认"
        />
      ) : (
        <div className="task-layout">
          <aside className="panel">
            <div className="panel-header">
              <div>
                <h2>任务列表</h2>
                <p className="page-description">按状态和标题快速定位。</p>
              </div>
            </div>

            <input
              className="task-search"
              placeholder="搜索标题或任务 ID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />

            <div className="segmented" style={{ marginBottom: 12 }}>
              {[
                ["all", "全部"],
                ["running", "执行中"],
                ["attention", "待处理"],
                ["succeeded", "已完成"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value as FilterMode)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="task-list">
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={activeTask?.id === task.id ? "task-card selected" : "task-card"}
                  onClick={() => openTask(task.id)}
                >
                  <span className="task-card-head">
                    <strong>{task.documentTitle}</strong>
                    <StatusBadge tone={taskStatusTone(task.status)}>{taskStatusLabel(task.status)}</StatusBadge>
                  </span>
                  <span className="task-meta">
                    {task.mode === "simulate" ? "模拟发布" : "mock 发布"} · {formatTime(task.updatedAt)}
                  </span>
                  <span className="task-platform-row">
                    {task.platforms.map((platform) => (
                      <PlatformBadge key={platform} platform={platform} />
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="panel">
            {activeTask ? (
              <>
                <div className="panel-header">
                  <div>
                    <h2>{activeTask.documentTitle}</h2>
                    <p className="page-description">
                      {activeTask.id} · {formatTime(activeTask.updatedAt)}
                    </p>
                  </div>
                  <StatusBadge tone={taskStatusTone(activeTask.status)}>{taskStatusLabel(activeTask.status)}</StatusBadge>
                </div>

                <div className="button-row">
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => handleRetry(activeTask.id)}
                    disabled={retryingKey === `${activeTask.id}-all`}
                  >
                    {retryingKey === `${activeTask.id}-all` ? <LoadingInline label="重试中" /> : <RotateCcw size={16} />}
                    重试未完成
                  </button>
                </div>

                <div className="result-list" style={{ marginTop: 16 }}>
                  {activeTask.results.map((result) => (
                    <article key={result.platform} className="result-card">
                      <div className="result-head">
                        <div>
                          <PlatformBadge platform={result.platform} />
                          <h3 style={{ marginTop: 8 }}>{platformLabel(result.platform)}</h3>
                          <p className="result-meta">
                            {result.account ? result.account.displayName : "未绑定账号"} · 第 {result.attemptCount} 次尝试
                          </p>
                        </div>
                        <StatusBadge tone={taskStatusTone(result.status)}>{taskStatusLabel(result.status)}</StatusBadge>
                      </div>

                      {result.url ? (
                        <a className="ghost-button compact" href={result.url} target="_blank" rel="noreferrer">
                          打开 mock 链接
                        </a>
                      ) : null}

                      {result.status !== "succeeded" ? (
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() => handleRetry(activeTask.id, result.platform)}
                          disabled={retryingKey === `${activeTask.id}-${result.platform}`}
                        >
                          {retryingKey === `${activeTask.id}-${result.platform}` ? (
                            <LoadingInline label="重试中" />
                          ) : (
                            <RotateCcw size={16} />
                          )}
                          重试 {platformLabel(result.platform)}
                        </button>
                      ) : null}

                      <div className="log-list">
                        {result.logs.map((log) => (
                          <div key={log.id} className="log-item">
                            <span>{new Date(log.timestamp).toLocaleTimeString("zh-CN")}</span>
                            <p>{log.message}</p>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>

                <div className="timeline-list" style={{ marginTop: 16 }}>
                  {activeTask.timeline.map((event) => (
                    <div key={event.id} className="timeline-item">
                      <div className="timeline-head">
                        <strong>{event.stage}</strong>
                        <span>{formatTime(event.timestamp)}</span>
                      </div>
                      <p>
                        {event.platform ? `${platformLabel(event.platform)} · ` : ""}
                        {event.message}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="选择一个任务" description="从左侧列表打开任务详情、日志和平台结果。" />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
