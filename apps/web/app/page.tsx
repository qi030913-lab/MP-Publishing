"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BookOpen,
  Eye,
  LayoutTemplate,
  MessageSquare,
  Radio,
  Send,
  Sparkles,
  SquarePen,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type PlatformName = "wechat" | "zhihu" | "bilibili" | "xiaohongshu";

type PreviewResult = {
  platform: PlatformName;
  title: string;
  summary?: string;
  body: string;
  hashtags: string[];
  warnings: Array<{
    code: string;
    message: string;
    severity: "info" | "warning" | "error";
  }>;
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
    description: "图文排版、导语、卡片信息密度更高。",
  },
  zhihu: {
    label: "知乎",
    icon: MessageSquare,
    tint: "#0f766e",
    description: "适合问题拆解、观点前置和层次表达。",
  },
  bilibili: {
    label: "B站",
    icon: Radio,
    tint: "#db2777",
    description: "偏口语表达、节奏感和话题标签。",
  },
  xiaohongshu: {
    label: "小红书",
    icon: Sparkles,
    tint: "#ea580c",
    description: "强调标题吸引力、体验感和标签氛围。",
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

function EmptyPreview() {
  return (
    <div
      style={{
        border: "1px dashed rgba(148, 163, 184, 0.4)",
        borderRadius: "8px",
        padding: "28px",
        minHeight: "240px",
        display: "grid",
        placeItems: "center",
        color: "#94a3b8",
        background: "rgba(15, 23, 42, 0.3)",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: "260px", lineHeight: 1.6 }}>
        填写标题和正文后，系统会在这里生成各平台预览、风格差异和风险提示。
      </div>
    </div>
  );
}

export default function HomePage() {
  const [title, setTitle] = useState("一篇内容，如何高效同步到多个创作平台");
  const [summary, setSummary] = useState("统一内容模型是多平台发布系统的第一块基石。");
  const [tags, setTags] = useState("内容运营, 创作者工具, 多平台发布");
  const [toneMode, setToneMode] = useState<"keep" | "platform-optimized">("platform-optimized");
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
  const [isLoading, setIsLoading] = useState(false);
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

  const activePreview = previewResults.find((item) => item.platform === activePlatform);
  const currentCapability = capabilities.find((item) => item.platform === activePlatform);

  useEffect(() => {
    async function loadPlatforms() {
      try {
        const response = await fetch("http://localhost:3001/platforms");
        const payload = (await response.json()) as { capabilities: PlatformCapability[] };
        setCapabilities(payload.capabilities);
      } catch {
        setCapabilities([]);
      }
    }

    void loadPlatforms();
  }, []);

  async function generatePreview() {
    setIsLoading(true);
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
      setError("预览接口暂时不可用，请确认 API 服务已启动在 http://localhost:3001。");
    } finally {
      setIsLoading(false);
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

      const next = [...current, platform];
      if (!current.includes(activePlatform)) {
        setActivePlatform(platform);
      }
      return next;
    });
  }

  const totalWarnings = previewResults.reduce((count, preview) => count + preview.warnings.length, 0);

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
        <section className="left-rail">
          <div className="hero-band">
            <p className="eyebrow">MP-Publishing</p>
            <h1>多平台创作与适配工作台</h1>
            <p className="hero-copy">
              先专注表达，再把同一篇内容分发为公众号、知乎、B站和小红书各自合适的版本。
            </p>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">创作输入</p>
                <h2>原稿编辑器</h2>
              </div>
              <div className="status-pill">
                <SquarePen size={16} />
                正在编辑
              </div>
            </div>

            <label className="field">
              <span>标题</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="输入内容标题"
              />
            </label>

            <div className="field-grid">
              <label className="field">
                <span>摘要</span>
                <textarea
                  rows={3}
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  placeholder="补充导语或摘要"
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
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => editor?.chain().focus().toggleBold().run()}
                    title="加粗"
                  >
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
                <div className="toolbar-hint">输入原稿，系统将自动拆分为平台预览。</div>
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
                  <button
                    type="button"
                    className={toneMode === "keep" ? "active" : ""}
                    onClick={() => setToneMode("keep")}
                  >
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
                <span>尽量保留原标题，不主动裁剪平台标题</span>
              </label>
            </div>
          </div>
        </section>

        <section className="right-rail">
          <div className="topbar panel">
            <div>
              <p className="section-kicker">适配设置</p>
              <h2>选择目标平台</h2>
            </div>
            <button type="button" className="primary-button" onClick={generatePreview} disabled={isLoading}>
              <Eye size={16} />
              {isLoading ? "生成中..." : "生成预览"}
            </button>
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
                  <div
                    className="platform-icon"
                    style={{ background: `${meta.tint}20`, color: meta.tint }}
                  >
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

          <div className="panel insights-panel">
            <div className="insight-card">
              <span className="insight-label">目标平台</span>
              <strong>{selectedPlatforms.length}</strong>
            </div>
            <div className="insight-card">
              <span className="insight-label">正文段落</span>
              <strong>{body ? body.split(/\n{2,}/).filter(Boolean).length : 0}</strong>
            </div>
            <div className="insight-card">
              <span className="insight-label">风险提示</span>
              <strong>{totalWarnings}</strong>
            </div>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          <div className="panel preview-shell">
            <div className="preview-header">
              <div>
                <p className="section-kicker">平台预览</p>
                <h2>逐平台查看差异</h2>
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
                      <p>当前平台预览没有明显风险项，可以继续进入模拟发布或一键发布流程。</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <EmptyPreview />
            )}
          </div>
        </section>
      </div>

      <style jsx>{`
        .workspace-shell {
          min-height: 100vh;
          padding: 28px;
        }

        .workspace-grid {
          max-width: 1480px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: minmax(0, 1.08fr) minmax(420px, 0.92fr);
          gap: 20px;
        }

        .left-rail,
        .right-rail {
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
          max-width: 780px;
        }

        .panel {
          padding: 24px;
        }

        .panel-header,
        .topbar,
        .preview-header,
        .preview-card-header {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
        }

        .status-pill,
        .preview-mode {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          background: rgba(37, 99, 235, 0.12);
          border: 1px solid rgba(37, 99, 235, 0.28);
          border-radius: 8px;
          color: #bfdbfe;
          white-space: nowrap;
        }

        .field-grid,
        .meta-grid,
        .platform-grid,
        .insights-panel {
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

        .field span,
        .control-label,
        .meta-label,
        .insight-label {
          font-size: 13px;
          color: #94a3b8;
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
        .platform-chip {
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

        .topbar {
          display: flex;
          align-items: center;
        }

        .primary-button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          border-radius: 8px;
          background: #2563eb;
          color: white;
        }

        .primary-button:disabled {
          opacity: 0.65;
          cursor: wait;
        }

        .platform-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
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

        .platform-copy span {
          color: #94a3b8;
          font-size: 13px;
          line-height: 1.6;
        }

        .insights-panel {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .insight-card {
          padding: 18px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(15, 23, 42, 0.84);
          display: grid;
          gap: 10px;
        }

        .insight-card strong {
          font-size: 24px;
        }

        .error-banner {
          padding: 14px 16px;
          border-radius: 8px;
          background: rgba(127, 29, 29, 0.36);
          border: 1px solid rgba(248, 113, 113, 0.28);
          color: #fecaca;
        }

        .preview-shell {
          min-height: 620px;
        }

        .tab-row {
          display: inline-flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .preview-card {
          display: grid;
          gap: 22px;
          padding-top: 22px;
        }

        .preview-card-header h3 {
          margin: 0;
          font-size: 24px;
        }

        .preview-card-header p {
          margin: 8px 0 0;
          color: #94a3b8;
          line-height: 1.6;
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

        .hashtag-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .hashtag-row span {
          padding: 8px 10px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.12);
          color: #bfdbfe;
          border: 1px solid rgba(37, 99, 235, 0.24);
        }

        .meta-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .meta-grid > div {
          padding: 14px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.14);
          background: rgba(15, 23, 42, 0.72);
          display: grid;
          gap: 8px;
        }

        .warning-list {
          display: grid;
          gap: 12px;
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

        .warning-item.error span {
          background: rgba(220, 38, 38, 0.16);
          color: #fecaca;
        }

        .warning-item p {
          margin: 0;
          line-height: 1.7;
          color: #cbd5e1;
        }

        @media (max-width: 1180px) {
          .workspace-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 760px) {
          .workspace-shell {
            padding: 16px;
          }

          .field-grid,
          .platform-grid,
          .insights-panel,
          .meta-grid {
            grid-template-columns: 1fr;
          }

          .panel-header,
          .topbar,
          .preview-header,
          .preview-card-header,
          .control-group {
            display: grid;
          }

          .tab-row {
            width: 100%;
          }

          .tab-row button {
            flex: 1 1 auto;
          }

          .warning-item {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}
