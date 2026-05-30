"use client";

import Link from "next/link";
import { PlayCircle, RadioTower, Rocket, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { getRuntimeStatus, listAccounts, runPublishAction } from "../lib/api";
import { loadDraft, saveActiveTaskId, saveDraft } from "../lib/draft-store";
import { platformLabel } from "../lib/platforms";
import type { DraftDocument, PlatformAccount, PlatformName, RuntimeStatus } from "../lib/types";
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

function connectorTone(status: RuntimeStatus["draftConnector"]["status"]): "success" | "warning" | "danger" | "info" {
  if (status === "online") return "success";
  if (status === "configured") return "warning";
  if (status === "offline") return "danger";
  return "info";
}

function connectorLabel(status: RuntimeStatus["draftConnector"]["status"]) {
  if (status === "online") return "连接器在线";
  if (status === "configured") return "端点已配置";
  if (status === "offline") return "连接器离线";
  return "未配置";
}

const connectorDraftPlatforms = new Set<PlatformName>(["zhihu", "bilibili", "xiaohongshu"]);

type DraftConnectorPlatformRuntime = RuntimeStatus["draftConnector"]["platforms"][number];

function getCredentialReadinessIssue(
  platformStatus: DraftConnectorPlatformRuntime | undefined,
  account: PlatformAccount | undefined,
) {
  if (!platformStatus?.draftCredentialRequired || account?.credentialStatus === "configured") {
    return null;
  }

  return `Set credentials for ${account?.credentialRef ?? platformLabel(platformStatus.platform)} before creating a credentialed ${platformStatus.platform} draft.`;
}

function isConnectorDraftReady(platform: PlatformName, runtime: RuntimeStatus | null, account?: PlatformAccount) {
  const platformStatus = runtime?.draftConnector.platforms.find((item) => item.platform === platform);
  return platformStatus?.draftReady === true && !getCredentialReadinessIssue(platformStatus, account);
}

export default function PublishPage() {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftDocument | null>(null);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
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

  const selectedConnectorDraftPlatforms = useMemo(
    () => draft?.platforms.filter((platform) => connectorDraftPlatforms.has(platform)) ?? [],
    [draft],
  );

  const readyConnectorDraftPlatforms = useMemo(
    () =>
      selectedConnectorDraftPlatforms.filter((platform) => {
        const account = accountsByPlatform.get(platform);
        return Boolean(account && isConnectorDraftReady(platform, runtime, account));
      }),
    [accountsByPlatform, runtime, selectedConnectorDraftPlatforms],
  );

  useEffect(() => {
    const storedDraft = loadDraft();
    setDraft(storedDraft);

    void Promise.all([listAccounts(), getRuntimeStatus()])
      .then(([payload, runtimePayload]) => {
        setAccounts(payload.items);
        setSelectedAccountIds(payload.items.map((account) => account.id));
        setRuntime(runtimePayload);
      })
      .catch(() => setError("读取发布运行状态失败，请确认 API 服务已经启动。"));
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

    const realDraftPlatforms = draft.platforms.filter(
      (platform) => {
        const account = selectedAccounts.find((item) => item.platform === platform);
        return connectorDraftPlatforms.has(platform) && Boolean(account && isConnectorDraftReady(platform, runtime, account));
      },
    );
    const realDraftAccountIds = selectedAccounts
      .filter((account) => realDraftPlatforms.includes(account.platform))
      .map((account) => account.id);

    if (realDraftPlatforms.length === 0) {
      setError("请先选择已就绪的知乎、B站或小红书连接器草稿平台，并为其选择可用账号。");
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
        description="发布前确认目标平台、账号健康状态和执行模式。真实草稿默认进入平台草稿或连接器草稿，不会越过平台最终确认。"
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
            <button
              className="secondary-button"
              type="button"
              onClick={submitRealDraft}
              disabled={isRealPublishing || !draft || readyConnectorDraftPlatforms.length === 0}
            >
              {isRealPublishing ? <LoadingInline label="提交中" /> : <Rocket size={18} />}
              创建连接器草稿
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
              <SummaryTile label="账号" value={selectedAccounts.length} detail={`连接器草稿 ${readyConnectorDraftPlatforms.length}`} />
            </div>

            <div className="field" style={{ marginTop: 18 }}>
              <span>目标平台</span>
              <PlatformPicker value={draft.platforms} onChange={updatePlatforms} />
            </div>

            <div className="subsection" style={{ marginTop: 18 }}>
              <div className="panel-header">
                <div>
                  <h3>真实草稿连接器</h3>
                  <p className="page-description">
                    {runtime?.draftConnector.detail ?? "正在读取连接器状态。"}
                  </p>
                </div>
                {runtime?.draftConnector ? (
                  <StatusBadge tone={connectorTone(runtime.draftConnector.status)}>
                    {connectorLabel(runtime.draftConnector.status)}
                  </StatusBadge>
                ) : null}
              </div>
              <div className="issue-list">
                {runtime?.draftConnector.platforms.map((platformStatus) => {
                  const account = accountsByPlatform.get(platformStatus.platform);
                  const credentialReadinessIssue = getCredentialReadinessIssue(platformStatus, account);
                  const readinessMessages = [
                    ...platformStatus.draftReadinessIssues.map((issue) => issue.message),
                    ...(credentialReadinessIssue ? [credentialReadinessIssue] : []),
                  ];
                  const connectorReady = isConnectorDraftReady(platformStatus.platform, runtime, account);

                  return (
                    <div key={platformStatus.platform} className={connectorReady ? "issue-item info" : "issue-item warning"}>
                      <RadioTower size={18} />
                      <div>
                        <strong>{platformLabel(platformStatus.platform)}</strong>
                        <p>
                          {connectorReady ? "可创建连接器草稿" : "暂不可创建连接器草稿"} /{" "}
                          {platformStatus.realPublishEnabled ? "真实草稿已启用" : "真实草稿未启用"} /{" "}
                          {platformStatus.draftEndpoint ? "draft endpoint 已配置" : "缺少 draft endpoint"}
                          {platformStatus.draftCredentialRequired ? " / 需要凭证转发" : ""}
                          {platformStatus.statusEndpoint ? " / status endpoint 已配置" : ""}
                          {platformStatus.upstreamDraftEndpointConfigured !== undefined ? (
                            <>
                              {" "}
                              / upstream {platformStatus.upstreamDraftStatus ?? "unknown"}
                              {platformStatus.upstreamStatusEndpointConfigured ? " / status sync" : ""}
                            </>
                          ) : null}
                        </p>
                        {!connectorReady && readinessMessages.length > 0 ? (
                          <p className="page-description">
                            Action: {readinessMessages.join(" ")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
              {runtime?.draftConnector.outboxUrl ? (
                <a className="secondary-button compact" href={runtime.draftConnector.outboxUrl} target="_blank" rel="noreferrer">
                  打开草稿收件箱
                </a>
              ) : null}
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
