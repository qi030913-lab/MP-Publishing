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
cp .env.example .env
pnpm infra:up
pnpm db:generate
pnpm db:push
pnpm build
```

On PowerShell, use this instead of `cp .env.example .env`:

```powershell
Copy-Item .env.example .env
```

## Development

The publishing flow now uses Prisma-backed persistence plus a BullMQ publish-target queue.

Run these services during local development:

```bash
pnpm infra:up
pnpm db:push
pnpm --filter @mp-publishing/api dev
pnpm --filter @mp-publishing/worker dev
pnpm --filter @mp-publishing/web dev
```

Verify the local publishing chain after a build:

```bash
pnpm test:publish-flow
```

This starts the built API and worker, creates a simulated publish task through HTTP, waits for BullMQ consumption, and checks that Postgres task state is updated successfully.

Required local services:

- PostgreSQL: stores accounts, documents, content versions, publish jobs, targets, attempts, worker state, and audit logs.
- Redis: backs the BullMQ queue consumed by `apps/worker`.

`pnpm infra:up` requires Docker Compose. If Docker is not available, run PostgreSQL and Redis yourself with the values from `.env.example`.
