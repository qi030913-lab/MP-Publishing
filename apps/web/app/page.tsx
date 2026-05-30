"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List, ListOrdered, Send, Sparkles, WandSparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { generatePreview } from "./lib/api";
import { defaultDraft, loadDraft, saveDraft, savePreviews } from "./lib/draft-store";
import type { DraftDocument, ToneMode } from "./lib/types";
import { PlatformPicker } from "./components/platform-picker";
import { LoadingInline, PageHeader, StageRail, SummaryTile } from "./components/ui";

function textToHtml(value: string) {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function htmlToText(html: string) {
  return html
    .replace(/<\/h[1-6]>/g, "\n\n")
    .replace(/<\/p>/g, "\n\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<li>/g, "- ")
    .replace(/<\/li>/g, "\n")
    .replace(/<\/ul>|<\/ol>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitTags(value: string) {
  return value
    .split(/[,\n，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export default function ComposePage() {
  const router = useRouter();
  const [title, setTitle] = useState(defaultDraft.title);
  const [summary, setSummary] = useState(defaultDraft.summary ?? "");
  const [tags, setTags] = useState(defaultDraft.tags.join(", "));
  const [body, setBody] = useState(defaultDraft.body);
  const [platforms, setPlatforms] = useState(defaultDraft.platforms);
  const [toneMode, setToneMode] = useState<ToneMode>(defaultDraft.toneMode);
  const [preserveOriginal, setPreserveOriginal] = useState(defaultDraft.preserveOriginal);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: textToHtml(defaultDraft.body),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "editor-surface",
      },
    },
    onUpdate({ editor: currentEditor }) {
      setBody(htmlToText(currentEditor.getHTML()));
    },
  });

  const draft = useMemo<DraftDocument>(
    () => ({
      title,
      summary,
      body,
      tags: splitTags(tags),
      platforms,
      toneMode,
      preserveOriginal,
    }),
    [body, platforms, preserveOriginal, summary, tags, title, toneMode],
  );

  useEffect(() => {
    const storedDraft = loadDraft();
    setTitle(storedDraft.title);
    setSummary(storedDraft.summary ?? "");
    setTags(storedDraft.tags.join(", "));
    setBody(storedDraft.body);
    setPlatforms(storedDraft.platforms);
    setToneMode(storedDraft.toneMode);
    setPreserveOriginal(storedDraft.preserveOriginal);
    editor?.commands.setContent(textToHtml(storedDraft.body));
  }, [editor]);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  async function handleGeneratePreview() {
    setIsLoading(true);
    setError(null);

    try {
      const payload = await generatePreview(draft);
      savePreviews(payload.previews);
      router.push("/preview");
    } catch {
      setError("生成平台预览失败，请确认本地 API 服务已经启动。");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <PageHeader
        kicker="Compose"
        title="创作台"
        description="在一个稳定的原稿模型里写内容，再把平台差异交给适配层处理。这里保留原稿、平台选择和语气策略。"
        actions={
          <button className="primary-button" type="button" onClick={handleGeneratePreview} disabled={isLoading}>
            {isLoading ? <LoadingInline label="生成中" /> : <WandSparkles size={18} />}
            生成预览
          </button>
        }
      />
      <StageRail active="compose" />

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="workspace-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>原稿</h2>
              <p className="page-description">标题、摘要、正文会被转换为 Canonical Content Model。</p>
            </div>
            <SummaryTile label="正文段落" value={body.split(/\n{2,}/).filter(Boolean).length} />
          </div>

          <div className="field-grid">
            <label className="field">
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field">
              <span>标签</span>
              <input value={tags} onChange={(event) => setTags(event.target.value)} />
            </label>
          </div>

          <label className="field" style={{ marginTop: 14 }}>
            <span>摘要</span>
            <textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>

          <div className="field" style={{ marginTop: 14 }}>
            <span>正文</span>
            <div className="editor-wrap">
              <div className="editor-toolbar">
                <div className="toolbar-group">
                  <button
                    className={editor?.isActive("bold") ? "icon-button active" : "icon-button"}
                    type="button"
                    aria-label="加粗"
                    onClick={() => editor?.chain().focus().toggleBold().run()}
                  >
                    <Bold size={17} />
                  </button>
                  <button
                    className={editor?.isActive("italic") ? "icon-button active" : "icon-button"}
                    type="button"
                    aria-label="斜体"
                    onClick={() => editor?.chain().focus().toggleItalic().run()}
                  >
                    <Italic size={17} />
                  </button>
                  <button
                    className={editor?.isActive("bulletList") ? "icon-button active" : "icon-button"}
                    type="button"
                    aria-label="无序列表"
                    onClick={() => editor?.chain().focus().toggleBulletList().run()}
                  >
                    <List size={17} />
                  </button>
                  <button
                    className={editor?.isActive("orderedList") ? "icon-button active" : "icon-button"}
                    type="button"
                    aria-label="有序列表"
                    onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                  >
                    <ListOrdered size={17} />
                  </button>
                </div>
                <span className="control-label">原稿会自动保存到浏览器本地</span>
              </div>
              <EditorContent editor={editor} />
            </div>
          </div>
        </section>

        <aside className="panel">
          <div className="panel-header">
            <div>
              <h2>适配策略</h2>
              <p className="page-description">先选择目标平台，再决定是否保留原文表达。</p>
            </div>
            <Sparkles color="var(--accent-2)" size={24} />
          </div>

          <div className="field">
            <span>目标平台</span>
            <PlatformPicker value={platforms} onChange={setPlatforms} />
          </div>

          <div className="field" style={{ marginTop: 18 }}>
            <span>语气模式</span>
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
                保持原稿
              </button>
            </div>
          </div>

          <label className="toggle-row" style={{ marginTop: 18 }}>
            <input
              type="checkbox"
              checked={preserveOriginal}
              onChange={(event) => setPreserveOriginal(event.target.checked)}
            />
            <span>锁定标题，不做平台后缀和裁剪改写</span>
          </label>

          <div className="action-row">
            <button className="primary-button" type="button" onClick={handleGeneratePreview} disabled={isLoading}>
              {isLoading ? <LoadingInline label="生成中" /> : <Send size={18} />}
              去预览台
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
