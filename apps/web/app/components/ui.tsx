import Link from "next/link";
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleDot, LoaderCircle } from "lucide-react";

import { platformAccent, platformLabel } from "../lib/platforms";
import type { PlatformName, TaskStatus, TaskTargetStatus, ValidationIssue } from "../lib/types";

export function PageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="kicker">{kicker}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function StageRail({ active }: { active: "compose" | "preview" | "publish" | "tasks" | "accounts" }) {
  const stages = [
    { id: "compose", label: "创作" },
    { id: "preview", label: "预览" },
    { id: "publish", label: "确认" },
    { id: "tasks", label: "任务" },
    { id: "accounts", label: "账号" },
  ] as const;

  const activeIndex = stages.findIndex((stage) => stage.id === active);

  return (
    <ol className="stage-rail" aria-label="发布链路">
      {stages.map((stage, index) => (
        <li key={stage.id} className={index <= activeIndex ? "stage-node complete" : "stage-node"}>
          <span>{index + 1}</span>
          <strong>{stage.label}</strong>
        </li>
      ))}
    </ol>
  );
}

export function StatusBadge({
  tone,
  children,
}: {
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return <span className={`status-badge ${tone}`}>{children}</span>;
}

export function SummaryTile({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="empty-state">
      <CircleDot size={24} />
      <strong>{title}</strong>
      <p>{description}</p>
      {actionHref && actionLabel ? (
        <Link className="secondary-button compact" href={actionHref}>
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function PlatformBadge({ platform }: { platform: PlatformName }) {
  return <span className={`platform-badge ${platformAccent[platform]}`}>{platformLabel(platform)}</span>;
}

export function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) {
    return (
      <div className="issue-list">
        <div className="issue-item success">
          <CheckCircle2 size={18} />
          <p>当前没有校验提示。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="issue-list">
      {issues.map((issue) => (
        <div key={`${issue.code}-${issue.message}`} className={`issue-item ${issue.severity}`}>
          {issue.severity === "error" ? <AlertCircle size={18} /> : <CircleDot size={18} />}
          <div>
            <strong>{issue.code}</strong>
            <p>{issue.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function taskStatusLabel(status: TaskStatus | TaskTargetStatus) {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "needs_manual_action") return "待人工处理";
  if (status === "needs_retry") return "待重试";
  return "部分完成";
}

export function taskStatusTone(status: TaskStatus | TaskTargetStatus): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "needs_manual_action" || status === "needs_retry" || status === "partial") return "warning";
  if (status === "queued" || status === "running") return "info";
  return "neutral";
}

export function LoadingInline({ label = "加载中" }: { label?: string }) {
  return (
    <span className="loading-inline">
      <LoaderCircle size={16} />
      {label}
    </span>
  );
}
