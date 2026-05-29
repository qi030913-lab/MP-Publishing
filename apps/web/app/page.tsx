import {
  adapterRegistry,
  summarizeCapabilities,
} from "@mp-publishing/adapter-core";
import { createDocumentSummary, exampleDocument } from "@mp-publishing/content-model";

const platforms = summarizeCapabilities(adapterRegistry.listCapabilities());
const documentSummary = createDocumentSummary(exampleDocument);

export default function HomePage() {
  return (
    <main
      style={{
        fontFamily: "Arial, sans-serif",
        margin: "0 auto",
        maxWidth: "1100px",
        padding: "48px 24px 72px",
        color: "#111827",
      }}
    >
      <section style={{ marginBottom: "40px" }}>
        <p style={{ fontSize: "12px", textTransform: "uppercase", color: "#6b7280" }}>
          MP-Publishing
        </p>
        <h1 style={{ fontSize: "36px", margin: "8px 0 12px" }}>
          多平台内容适配与发布工作台
        </h1>
        <p style={{ fontSize: "16px", lineHeight: 1.6, maxWidth: "760px", color: "#374151" }}>
          当前骨架已经具备统一内容模型、平台适配器注册中心，以及 Web / API / Worker
          的基础分层。下一步可以直接接入编辑器、任务队列和真实平台能力。
        </p>
      </section>

      <section
        style={{
          display: "grid",
          gap: "16px",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          marginBottom: "40px",
        }}
      >
        <article
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            padding: "20px",
            background: "#f9fafb",
          }}
        >
          <h2 style={{ fontSize: "18px", marginTop: 0 }}>统一内容模型</h2>
          <p style={{ marginBottom: "8px", color: "#4b5563" }}>{documentSummary}</p>
          <ul style={{ paddingLeft: "20px", margin: 0, color: "#4b5563" }}>
            <li>标题：{exampleDocument.title}</li>
            <li>段落块数：{exampleDocument.blocks.length}</li>
            <li>主题标签：{exampleDocument.metadata.topics.join(", ")}</li>
          </ul>
        </article>

        <article
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            padding: "20px",
            background: "#f9fafb",
          }}
        >
          <h2 style={{ fontSize: "18px", marginTop: 0 }}>平台注册中心</h2>
          <p style={{ marginBottom: "8px", color: "#4b5563" }}>
            当前已内置示例平台，并通过统一接口暴露能力描述和适配结果。
          </p>
          <ul style={{ paddingLeft: "20px", margin: 0, color: "#4b5563" }}>
            {platforms.map((platform) => (
              <li key={platform.platform}>{platform.summary}</li>
            ))}
          </ul>
        </article>
      </section>

      <section>
        <h2 style={{ fontSize: "22px", marginBottom: "16px" }}>建议的后续实现顺序</h2>
        <ol style={{ paddingLeft: "20px", color: "#374151", lineHeight: 1.8 }}>
          <li>接入 Tiptap 编辑器，并将编辑结果映射到 Canonical Content Model。</li>
          <li>在 API 中补齐文档、预览、发布任务和账号管理模块。</li>
          <li>引入 Redis + BullMQ，打通适配、模拟发布和真实发布任务。</li>
          <li>扩展更多平台适配器，并接入官方 API 或 Playwright 自动化流程。</li>
        </ol>
      </section>
    </main>
  );
}
