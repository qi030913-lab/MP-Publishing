"use client";

import Link from "next/link";
import { PlayCircle, RadioTower, Rocket, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { listAccounts, runPublishAction } from "../lib/api";
import { loadDraft, saveActiveTaskId, saveDraft } from "../lib/draft-store";
import { platformLabel } from "../lib/platforms";
import type { DraftDocument, PlatformAccount } from "../lib/types";
import { PlatformPicker } from "../components/platform-picker";
import {
  EmptyState,
  LoadingInline,
  PageHeader,
  PlatformBadge,
  StageRail,
  StatusBadge,
  SummaryTile,
} from "../components/ui";

function healthTone(health: PlatformAccount["health"]): "success" | "warning" | "danger" {
  if (health === "healthy") return "success";
  if (health === "expiring") return "warning";
  return "danger";
}

function healthLabel(health: PlatformAccount["health"]) {
  if (health === "healthy") return "健康";
  if (health === "expiring") return "即将过期";
  return "需要登录";
}

export default function PublishPage() {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftDocument | null>(null);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRealPublishing, setIsRealPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAccounts = useMemo(
    () => accounts.filter((account) => selectedAccountIds.includes(account.id)),
    [accounts, selectedAccountIds],
  );

  const accountsByPlatform = useMemo(
    () => new Map(selectedAccounts.map((account) => [account.platform, account])),
    [selectedAccounts],
  );

  useEffect(() => {
    const storedDraft = loadDraft();
    setDraft(storedDraft);

    void listAccounts()
      .then((payload) => {
        setAccounts(payload.items);
        setSelectedAccountIds(payload.items.map((account) => account.id));
      })
      .catch(() => setError("读取账号列表失败，请确认 API 服务已经启动。"));
  }, []);

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((current) =>
      current.includes(accountId) ? current.filter((id) => id !== accountId) : [...current, accountId],
    );
  }

  function updatePlatforms(platforms: DraftDocument["platforms"]) {
    if (!draft) {
      return;
    }

    const nextDraft = { ...draft, platforms };
    setDraft(nextDraft);
    saveDraft(nextDraft);
  }

  async function submit(mode: "simulate" | "mock") {
    if (!draft) {
      return;
    }

    setError(null);
    const setLoading = mode === "simulate" ? setIsSimulating : setIsPublishing;
    setLoading(true);

    try {
      const task = await runPublishAction(mode, draft, selectedAccountIds);
      saveActiveTaskId(task.id);
      router.push("/tasks");
    } catch {
      setError(mode === "simulate" ? "模拟发布失败，请检查 API 服务。" : "mock 发布失败，请检查 API 服务。");
    } finally {
      setLoading(false);
    }
  }

  async function submitRealDraft() {
    if (!draft) {
      return;
    }

    const realDraftPlatforms = draft.platforms.filter((platform) =>
      selectedAccounts.some((account) => account.platform === platform),
    );
    const realDraftAccountIds = selectedAccounts
      .filter((account) => realDraftPlatforms.includes(account.platform))
      .map((account) => account.id);

    if (realDraftPlatforms.length === 0) {
      setError("请先为目标平台选择可用账号。");
      return;
    }

    setError(null);
    setIsRealPublishing(true);

    try {
      const task = await runPublishAction("real", { ...draft, platforms: realDraftPlatforms }, realDraftAccountIds);
      saveActiveTaskId(task.id);
      router.push("/tasks");
    } catch {
      setError("真实草稿任务创建失败，请检查 API 服务、平台账号和连接器配置。");
    } finally {
      setIsRealPublishing(false);
    }
  }

  return (
    <div className="page-shell">
      <PageHeader
        kicker="Publish"
        title="发布确认"
        description="发布前确认目标平台、账号健康状态和执行模式。真实发布默认进入平台草稿或连接器草稿，不会越过平台最终确认。"
        actions={
          <>
            <button className="secondary-button" type="button" onClick={() => submit("simulate")} disabled={isSimulating}>
              {isSimulating ? <LoadingInline label="预演中" /> : <PlayCircle size={18} />}
              模拟发布
            </button>
            <button className="primary-button" type="button" onClick={() => submit("mock")} disabled={isPublishing}>
              {isPublishing ? <LoadingInline label="提交中" /> : <Rocket size={18} />}
              mock 一键发布
            </button>
            <button className="secondary-button" type="button" onClick={submitRealDraft} disabled={isRealPublishing}>
              {isRealPublishing ? <LoadingInline label="提交中" /> : <Rocket size={18} />}
              创建真实草稿
            </button>
          </>
        }
      />
      <StageRail active="publish" />

      {error ? <div className="error-banner">{error}</div> : null}

      {!draft ? (
        <EmptyState title="没有可发布的原稿" description="请先在创作台保存一份原稿。" actionHref="/" actionLabel="去创作台" />
      ) : (
        <div className="workspace-grid">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>发布包</h2>
                <p className="page-description">{draft.title}</p>
              </div>
              <StatusBadge tone="info">{draft.platforms.length} 个平台</StatusBadge>
            </div>

            <div className="summary-grid">
              <SummaryTile label="正文段落" value={draft.body.split(/\n{2,}/).filter(Boolean).length} />
              <SummaryTile label="标签" value={draft.tags.length} />
              <SummaryTile label="账号" value={selectedAccounts.length} />
            </div>

            <div className="field" style={{ marginTop: 18 }}>
              <span>目标平台</span>
              <PlatformPicker value={draft.platforms} onChange={updatePlatforms} />
            </div>

            <div className="subsection" style={{ marginTop: 18 }}>
              <div className="panel-header">
                <div>
                  <h3>平台账号匹配</h3>
                  <p className="page-description">没有匹配账号的平台会进入待人工处理。</p>
                </div>
                <ShieldCheck color="var(--accent-2)" />
              </div>
              <div className="issue-list">
                {draft.platforms.map((platform) => {
                  const account = accountsByPlatform.get(platform);

                  return (
                    <div key={platform} className="issue-item info">
                      <RadioTower size={18} />
                      <div>
                        <strong>{platformLabel(platform)}</strong>
                        <p>{account ? `${account.displayName} / ${healthLabel(account.health)}` : "未选择账号"}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="panel">
            <div className="panel-header">
              <div>
                <h2>账号选择</h2>
                <p className="page-description">当前账号来自本地 runtime demo 数据。</p>
              </div>
              <Link className="secondary-button compact" href="/accounts">
                管理账号
              </Link>
            </div>

            <div className="account-list">
              {accounts.map((account) => (
                <label
                  key={account.id}
                  className={selectedAccountIds.includes(account.id) ? "account-card selected" : "account-card"}
                >
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.includes(account.id)}
                    onChange={() => toggleAccount(account.id)}
                  />
                  <span>
                    <span className="account-head">
                      <strong>{account.displayName}</strong>
                      <StatusBadge tone={healthTone(account.health)}>{healthLabel(account.health)}</StatusBadge>
                    </span>
                    <span className="account-meta">
                      <PlatformBadge platform={account.platform} /> {account.handle} · {account.authMode}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
