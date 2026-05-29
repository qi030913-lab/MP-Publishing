# MP-Publishing

MP-Publishing is a multi-platform content adaptation and publishing workspace for creators who need to distribute one piece of content to channels such as WeChat Official Accounts, Zhihu, Bilibili, and Xiaohongshu.

## Workspace Layout

- `apps/web`: creator console and multi-platform preview workspace
- `apps/api`: orchestration API for content, preview, and publishing jobs
- `apps/worker`: async task runner for adaptation, simulation, and publishing
- `packages/content-model`: canonical content schema and helpers
- `packages/adapter-core`: shared adapter contracts and orchestration primitives
- `packages/adapters/xiaohongshu`: sample platform adapter implementation
- `docs/architecture.md`: architecture and technical design notes

## Getting Started

```bash
pnpm install
pnpm build
```
