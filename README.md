# MP-Publishing

MP-Publishing is a multi-platform content adaptation and publishing workspace for creators who need to distribute one piece of content to channels such as WeChat Official Accounts, Zhihu, Bilibili, and Xiaohongshu.

## Workspace Layout

- `apps/web`: creator console and multi-platform preview workspace
- `apps/api`: orchestration API for content, preview, and publishing jobs
- `apps/worker`: async task runner for adaptation, simulation, and publishing
- `apps/draft-connector`: local draft outbox connector for non-WeChat draft publishing
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
pnpm drafts:enable-local
pnpm --filter @mp-publishing/api dev
pnpm --filter @mp-publishing/worker dev
pnpm --filter @mp-publishing/draft-connector dev
pnpm --filter @mp-publishing/web dev
```

For local Zhihu, Bilibili, and Xiaohongshu draft publishing, run `pnpm drafts:enable-local` once to turn on the three connector-backed draft targets in `.env`, then run `apps/draft-connector`.
The draft connector loads the workspace `.env` on startup, so local connector keys, outbox paths, and upstream endpoints can live in the same file as the API and worker settings.
Relative `DRAFT_CONNECTOR_OUTBOX_DIR` values are resolved from the workspace root, including when the connector is started through `pnpm --filter @mp-publishing/draft-connector dev`.
With `DRAFT_CONNECTOR_BASE_URL=http://localhost:3010`, per-platform draft and status endpoints are inferred automatically.
The local connector returns browsable draft detail URLs such as `http://localhost:3010/zhihu/drafts/<id>` and outbox list views at `http://localhost:3010/drafts` or `/:platform/drafts`; set `DRAFT_CONNECTOR_PUBLIC_BASE_URL` when it runs behind a proxy.
When per-platform draft endpoints are configured explicitly, set `DRAFT_CONNECTOR_HEALTH_URL` to keep API preflight health checks; local `localhost`/`127.0.0.1` `/:platform/drafts` endpoints infer `/health` automatically.
Set `DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_DRAFT_ENDPOINT` when the local connector should synchronously forward drafts to an official API proxy or creator-center automation service; upstream responses with `remoteId` and `url` are persisted in the outbox and returned to the publish task.
If that upstream service needs platform credentials, enable both the adapter-to-connector flag such as `ZHIHU_DRAFT_INCLUDE_CREDENTIAL=true` and the connector-to-upstream flag such as `DRAFT_CONNECTOR_ZHIHU_UPSTREAM_INCLUDE_CREDENTIAL=true`; credentials are forwarded only for that request and are not stored in local outbox files.
When a real draft target requires credential forwarding but the selected account has no usable env-backed credential, or when the local connector is configured to forward upstream credentials but the adapter-side `*_DRAFT_INCLUDE_CREDENTIAL` flag is missing, API preflight marks that target as `needs_manual_action` before queueing.
When an upstream draft service exposes a readiness route, configure `DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_HEALTH_ENDPOINT` or `DRAFT_CONNECTOR_UPSTREAM_HEALTH_ENDPOINT` so connector health and API preflight can detect an offline upstream before queueing work.
Set `DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_STATUS_ENDPOINT` when the connector should forward manual task sync requests to that upstream service and persist the returned remote draft state in the outbox; status sync has separate `*_STATUS_INCLUDE_CREDENTIAL` flags for both hops.
External API proxies or automation workers can also call `POST /:platform/drafts/:draftId/status` on the connector to attach or refresh the real platform draft id and URL; the task sync action then updates the publish target from the local outbox URL to that external draft URL.
The API exposes connector readiness in `/runtime/status`, and the publish page shows whether the draft connector is online before creating connector-backed Zhihu/Bilibili/Xiaohongshu draft tasks.
When a real draft target is not enabled, has no draft endpoint, uses an inferred local connector endpoint while that connector is offline, or declares an offline upstream health endpoint, the API marks that target as needing manual action before it reaches the worker queue.
Task details show target-level validation issues so connector preflight failures are visible without reading raw logs.
Retrying a real draft target reruns connector preflight first, so unresolved connector configuration issues stay in manual action instead of entering the worker queue.

Verify the local publishing chain after a build:

```bash
pnpm test:publish-flow
pnpm test:draft-connectors
```

This starts the built API and worker, creates a simulated publish task through HTTP, waits for BullMQ consumption, and checks that Postgres task state is updated successfully.
The draft connector test starts the built local draft connector and verifies workspace `.env` bootstrap, local enablement script output, three-platform disabled/missing-credential/credential-forwarding-mismatch/offline-connector/explicit-local-endpoint/offline-upstream preflight behavior, retry preflight queue protection, three-platform offline-upstream recovery after retry, connector readiness reporting, Zhihu/Bilibili/Xiaohongshu real-draft task results, synchronous upstream draft forwarding, upstream rejection as manual action with local draft URLs and retry recovery, credential-gated upstream draft/status forwarding without outbox credential persistence, upstream status sync forwarding, browsable draft detail URLs, external draft URL handoff, outbox list entries, local outbox draft files, and manual status sync results when their connector endpoints are configured.

Required local services:

- PostgreSQL: stores accounts, documents, content versions, publish jobs, targets, attempts, worker state, and audit logs.
- Redis: backs the BullMQ queue consumed by `apps/worker`.

`pnpm infra:up` requires Docker Compose. If Docker is not available, run PostgreSQL and Redis yourself with the values from `.env.example`.
