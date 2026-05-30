"use client";

import Link from "next/link";
import { RefreshCcw, Rocket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { generatePreview, listPlatforms } from "../lib/api";
import { loadDraft, loadPreviews, savePreviews } from "../lib/draft-store";
import { platformLabel, platformOrder } from "../lib/platforms";
import type { DraftDocument, PlatformCapability, PlatformName, PreviewResult } from "../lib/types";
import {
  EmptyState,
  IssueList,
  LoadingInline,
  PageHeader,
  PlatformBadge,
  StageRail,
  StatusBadge,
  SummaryTile,
} from "../components/ui";

function formatBody(body: string) {
  return body.split("\n").map((line, index) => (
    <p key={`${line}-${index}`}>{line.length > 0 ? line : "\u00a0"}</p>
  ));
}

export default function PreviewPage() {
  const [draft, setDraft] = useState<DraftDocument | null>(null);
  const [previews, setPreviews] = useState<PreviewResult[]>([]);
  const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);
  const [activePlatform, setActivePlatform] = useState<PlatformName>("wechat");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePreview = previews.find((preview) => preview.platform === activePlatform) ?? previews[0];
  const activeCapability = capabilities.find((capability) => capability.platform === activePreview?.platform);
  const totalWarnings = previews.reduce((count, preview) => count + preview.warnings.length, 0);

  const orderedPreviews = useMemo(
    () =>
      platformOrder
        .map((platform) => previews.find((preview) => preview.platform === platform))
        .filter((preview): preview is PreviewResult => Boolean(preview)),
    [previews],
  );

  useEffect(() => {
    const storedDraft = loadDraft();
    const storedPreviews = loadPreviews();
    setDraft(storedDraft);
    setPreviews(storedPreviews);
    setActivePlatform(storedPreviews[0]?.platform ?? storedDraft.platforms[0] ?? "wechat");

    void listPlatforms()
      .then((payload) => setCapabilities(payload.capabilities))
      .catch(() => setError("读取平台能力失败，请确认 API 服务已经启动。"));
  }, []);

  async function refreshPreview() {
    if (!draft) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const payload = await generatePreview(draft);
      setPreviews(payload.previews);
      savePreviews(payload.previews);
      setActivePlatform(payload.previews[0]?.platform ?? activePlatform);
    } catch {
      setError("刷新预览失败，请确认本地 API 服务已经启动。");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <PageHeader
        kicker="Preview"
        title="多平台预览台"
        description="把同一份原稿拆成不同平台的标题、导语、正文和标签，提前看到降级提示。"
        actions={
          <>
            <button className="secondary-button" type="button" onClick={refreshPreview} disabled={isLoading}>
              {isLoading ? <LoadingInline label="刷新中" /> : <RefreshCcw size={18} />}
              刷新预览
            </button>
            <Link className="primary-button" href="/publish">
              <Rocket size={18} />
              去发布确认
            </Link>
          </>
        }
      />
      <StageRail active="preview" />

      {error ? <div className="error-banner">{error}</div> : null}

      {orderedPreviews.length === 0 ? (
        <EmptyState
          title="还没有平台预览"
          description="先在创作台生成预览，或者直接刷新当前浏览器保存的原稿。"
          actionHref="/"
          actionLabel="回到创作台"
        />
      ) : (
        <div className="preview-layout">
          <aside className="panel">
            <div className="panel-header">
              <div>
                <h2>平台切换</h2>
                <p className="page-description">当前共 {orderedPreviews.length} 个平台草稿。</p>
              </div>
            </div>
            <div className="tab-list">
              {orderedPreviews.map((preview) => (
                <button
                  key={preview.platform}
                  type="button"
                  className={activePreview?.platform === preview.platform ? "tab-button active" : "tab-button"}
                  onClick={() => setActivePlatform(preview.platform)}
                >
                  <span>{platformLabel(preview.platform)}</span>
                  <StatusBadge tone={preview.warnings.length > 0 ? "warning" : "success"}>
                    {preview.warnings.length} 提示
                  </StatusBadge>
                </button>
              ))}
            </div>

            <div className="summary-grid" style={{ marginTop: 16 }}>
              <SummaryTile label="预览平台" value={orderedPreviews.length} />
              <SummaryTile label="总提示" value={totalWarnings} />
              <SummaryTile label="原稿标签" value={draft?.tags.length ?? 0} />
            </div>
          </aside>

          {activePreview ? (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <PlatformBadge platform={activePreview.platform} />
                  <h2 style={{ marginTop: 10 }}>{platformLabel(activePreview.platform)} 草稿</h2>
                </div>
                <StatusBadge tone={activePreview.warnings.length > 0 ? "warning" : "success"}>
                  {activePreview.warnings.length > 0 ? "需要留意" : "状态良好"}
                </StatusBadge>
              </div>

              <article className="preview-paper">
                <h2>{activePreview.title}</h2>
                {activePreview.summary ? <p className="preview-summary">{activePreview.summary}</p> : null}
                <div className="preview-body">{formatBody(activePreview.body)}</div>
                {activePreview.hashtags.length > 0 ? (
                  <div className="hashtag-row" style={{ marginTop: 24 }}>
                    {activePreview.hashtags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                ) : null}
              </article>

              <div className="two-column-grid" style={{ marginTop: 18 }}>
                <div>
                  <h3>校验提示</h3>
                  <IssueList issues={activePreview.warnings} />
                </div>
                <div>
                  <h3>平台能力</h3>
                  <div className="capability-grid">
                    <div className="capability-item">
                      <span>发布模式</span>
                      <strong>{activeCapability?.publishMode ?? "未知"}</strong>
                    </div>
                    <div className="capability-item">
                      <span>标题上限</span>
                      <strong>{activeCapability?.titleMaxLength ?? "未限制"}</strong>
                    </div>
                    <div className="capability-item">
                      <span>Markdown</span>
                      <strong>{activeCapability?.supportsMarkdown ? "支持" : "不支持"}</strong>
                    </div>
                    <div className="capability-item">
                      <span>定时发布</span>
                      <strong>{activeCapability?.supportsScheduling ? "支持" : "不支持"}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
