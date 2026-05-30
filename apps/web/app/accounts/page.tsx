"use client";

import { RefreshCcw, RotateCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { accountAction, listAccounts } from "../lib/api";
import type { AccountSummary, PlatformAccount } from "../lib/types";
import {
  LoadingInline,
  PageHeader,
  PlatformBadge,
  StageRail,
  StatusBadge,
  SummaryTile,
} from "../components/ui";

function emptySummary(): AccountSummary {
  return {
    total: 0,
    healthy: 0,
    expiring: 0,
    needsLogin: 0,
  };
}

function healthTone(health: PlatformAccount["health"]): "success" | "warning" | "danger" {
  if (health === "healthy") return "success";
  if (health === "expiring") return "warning";
  return "danger";
}

function healthLabel(health: PlatformAccount["health"]) {
  if (health === "healthy") return "健康";
  if (health === "expiring") return "即将过期";
  return "需要重新登录";
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [summary, setSummary] = useState<AccountSummary>(emptySummary);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshAccounts() {
    setIsRefreshing(true);
    setError(null);

    try {
      const payload = await listAccounts();
      setAccounts(payload.items);
      setSummary(payload.summary);
    } catch {
      setError("读取账号列表失败，请确认 API 服务已经启动。");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function runAction(accountId: string, action: "check" | "refresh" | "mark-needs-login") {
    const key = `${accountId}-${action}`;
    setLoadingAction(key);
    setError(null);

    try {
      await accountAction(accountId, action);
      await refreshAccounts();
    } catch {
      setError("账号操作失败，请稍后重试。");
    } finally {
      setLoadingAction(null);
    }
  }

  useEffect(() => {
    void refreshAccounts();
  }, []);

  return (
    <div className="page-shell">
      <PageHeader
        kicker="Accounts"
        title="账号管理"
        description="账号层暂时使用本地 demo 状态，后续会接入真实 OAuth、Cookie Session 和加密凭证。"
        actions={
          <button className="secondary-button" type="button" onClick={refreshAccounts} disabled={isRefreshing}>
            {isRefreshing ? <LoadingInline label="刷新中" /> : <RefreshCcw size={18} />}
            刷新账号
          </button>
        }
      />
      <StageRail active="accounts" />

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="panel">
        <div className="account-summary-grid">
          <SummaryTile label="总账号" value={summary.total} />
          <SummaryTile label="健康" value={summary.healthy} />
          <SummaryTile label="即将过期" value={summary.expiring} />
          <SummaryTile label="需登录" value={summary.needsLogin} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>平台账号</h2>
            <p className="page-description">健康检查和刷新会直接更新本地 runtime 状态。</p>
          </div>
        </div>

        <div className="account-list">
          {accounts.map((account) => (
            <article key={account.id} className="account-card">
              <ShieldCheck color={account.health === "healthy" ? "var(--success)" : "var(--warning)"} size={20} />
              <div>
                <div className="account-head">
                  <div>
                    <h3>{account.displayName}</h3>
                    <p className="account-meta">
                      <PlatformBadge platform={account.platform} /> {account.handle} · {account.authMode}
                    </p>
                  </div>
                  <StatusBadge tone={healthTone(account.health)}>{healthLabel(account.health)}</StatusBadge>
                </div>

                <p className="account-meta">上次检查：{new Date(account.lastCheckedAt).toLocaleString("zh-CN")}</p>

                <div className="account-actions">
                  <button
                    className="account-action-button compact"
                    type="button"
                    onClick={() => runAction(account.id, "check")}
                    disabled={loadingAction === `${account.id}-check`}
                  >
                    {loadingAction === `${account.id}-check` ? <LoadingInline label="检查中" /> : <ShieldCheck size={16} />}
                    健康检查
                  </button>
                  <button
                    className="account-action-button compact"
                    type="button"
                    onClick={() => runAction(account.id, "refresh")}
                    disabled={loadingAction === `${account.id}-refresh`}
                  >
                    {loadingAction === `${account.id}-refresh` ? <LoadingInline label="刷新中" /> : <RotateCw size={16} />}
                    刷新凭证
                  </button>
                  <button
                    className="account-action-button compact"
                    type="button"
                    onClick={() => runAction(account.id, "mark-needs-login")}
                    disabled={loadingAction === `${account.id}-mark-needs-login`}
                  >
                    {loadingAction === `${account.id}-mark-needs-login` ? (
                      <LoadingInline label="标记中" />
                    ) : (
                      <ShieldAlert size={16} />
                    )}
                    标记需登录
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
