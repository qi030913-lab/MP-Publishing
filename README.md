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
The local connector returns browsable draft detail URLs such as `http://localhost:3010/zhihu/drafts/<id>` and outbox list views at `http://localhost:3010/drafts` or `/:platform/drafts`; set `DRAFT_CONNECTOR_PUBLIC_BASE_URL` when it runs behind a proxy so `/runtime/status`, the publish page, and the task center expose public outbox links instead of internal service URLs.
Connector draft requests carry publish task, target, and attempt context so repeated delivery of the same worker attempt reuses the existing outbox draft instead of creating duplicate platform drafts.
When per-platform draft endpoints are configured explicitly, set `DRAFT_CONNECTOR_HEALTH_URL` to keep API preflight health checks; local `localhost`/`127.0.0.1` `/:platform/drafts` endpoints infer `/health` and matching `/:platform/status` endpoints automatically.
Set `DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_DRAFT_ENDPOINT` when the local connector should synchronously forward drafts to an official API proxy or creator-center automation service; upstream responses with `remoteId` and `url` are persisted in the outbox and returned to the publish task.
Open `GET /contract` on the draft connector to inspect the machine-readable upstream proxy contract, including draft/status payloads, status callback shape, supported draft states, and credential-forwarding flags.
Run `pnpm drafts:upstream-sandbox -- --port 3020 --api-key sandbox-secret` to start a local upstream proxy sandbox that implements the same draft/status/health contract and stores accepted proxy drafts in `.runtime/draft-upstream-sandbox`; add `--callback --async-response --connector-api-key <callback-key>` to rehearse creator-center automation that accepts a draft first and writes the real draft URL back through the connector callback.
The sandbox also writes creator-center work orders for each accepted draft; open `GET /work-orders` or `GET /:platform/work-orders/:remoteId` to inspect the title/body/tag payload, required fill checklist, safe-mode automation hints, and connector callback payload template that a real Playwright or private upstream service should execute. After a human or automation saves the real platform draft, call `POST /:platform/work-orders/:remoteId/complete` with the real draft id and URL so the sandbox records completion and callbacks the connector.
Run `pnpm drafts:automation-service -- --port 3030 --api-key automation-secret` to start a local automation endpoint for those work orders. By default it stores a local handoff record at `/:platform/drafts/:automationDraftId`; pass `--handler-module ./path/to/handler.mjs` when a real Playwright or official-API implementation should create the platform draft and return the real draft id/URL. Handler modules receive the selected platform's `DRAFT_AUTOMATION_<PLATFORM>_ACCESS_TOKEN`, `*_COOKIES`, `*_STORAGE_STATE_JSON`, `*_STORAGE_STATE_PATH`, and creator URL settings as `platformSession`; `/health` and `/contract` expose only a redacted readiness summary, and the service does not persist those session secrets in outbox records. Add `--require-session` or `DRAFT_AUTOMATION_<PLATFORM>_REQUIRE_SESSION=true` to reject work orders before handler execution when the needed login material is missing. The built-in `scripts/handlers/playwright-draft-handler.mjs` can drive creator-center pages when Playwright is installed and `DRAFT_AUTOMATION_<PLATFORM>_PLAYWRIGHT_SELECTORS_JSON` or `*_SELECTORS_PATH` provides selectors for title, body, optional summary/tags, save-draft, and result URL extraction.
Run `pnpm drafts:run-work-orders -- --sandbox-base-url http://localhost:3020 --api-key sandbox-secret --once` to execute those pending sandbox work orders with a local runner; by default it calls the same completion endpoint with generated creator-center draft links for sandbox rehearsal. Add `--automation-endpoint <url>` and `--automation-api-key <key>` when a real Playwright or official-API worker should receive the full work order and return the platform draft id/URL; add `--require-automation` to fail instead of falling back to generated links.
Set `DRAFT_CONNECTOR_STATUS_CALLBACK_API_KEY` when upstream automation should only be allowed to update `/:platform/drafts/:draftId/status`; draft creation and connector status-sync requests continue to require `DRAFT_CONNECTOR_API_KEY`, while the callback route also accepts the main key for operator compatibility.
Run `pnpm drafts:enable-upstream -- --proxy-base-url <url>` to write the three-platform upstream proxy endpoints into `.env`; pass `--include-credential`, `--status-include-credential`, and `--check` when the proxy should receive account credentials and be contract-checked immediately with the configured connector/public callback base URL.
Run `pnpm drafts:check-upstream -- --platform <platform> --draft-endpoint <url>` against a sandbox upstream proxy before enabling it in `.env`; add `--status-endpoint`, `--health-endpoint`, and credential flags when the proxy will support status sync or credential forwarding.

```bash
pnpm drafts:upstream-sandbox -- --port 3020 --api-key sandbox-secret --callback --async-response --connector-api-key "$DRAFT_CONNECTOR_STATUS_CALLBACK_API_KEY"
pnpm drafts:automation-service -- --port 3030 --api-key automation-secret
pnpm drafts:automation-service -- --port 3030 --api-key automation-secret --handler-module scripts/handlers/playwright-draft-handler.mjs --require-session
pnpm drafts:run-work-orders -- --sandbox-base-url http://localhost:3020 --api-key sandbox-secret --once
pnpm drafts:run-work-orders -- --sandbox-base-url http://localhost:3020 --api-key sandbox-secret --automation-endpoint http://localhost:3030/drafts --automation-api-key automation-secret --require-automation --once
pnpm drafts:enable-upstream -- --proxy-base-url https://proxy.example.com --api-key "$PROXY_API_KEY" --include-credential --status-include-credential --check
pnpm drafts:check-upstream -- --platform zhihu --draft-endpoint https://proxy.example.com/zhihu/drafts --status-endpoint https://proxy.example.com/zhihu/status --health-endpoint https://proxy.example.com/health --api-key "$PROXY_API_KEY"
```

If a restart leaves an upstream-backed draft reserved as `publishing`, the connector resumes forwarding after `DRAFT_CONNECTOR_UPSTREAM_RESUME_AFTER_MS` milliseconds, which defaults to `120000`; fresh in-flight reservations are reused instead of forwarded twice.
If that upstream service needs platform credentials, enable both the adapter-to-connector flag such as `ZHIHU_DRAFT_INCLUDE_CREDENTIAL=true` and the connector-to-upstream flag such as `DRAFT_CONNECTOR_ZHIHU_UPSTREAM_INCLUDE_CREDENTIAL=true`; status sync uses matching `*_STATUS_INCLUDE_CREDENTIAL` flags. Credentials are forwarded only for that request and are not stored in local outbox files.
When a real draft target requires credential forwarding but the selected account has no usable env-backed credential, or when the local connector is configured to forward upstream credentials but the adapter-side `*_DRAFT_INCLUDE_CREDENTIAL` flag is missing, API preflight marks that target as `needs_manual_action` before queueing.
When an upstream draft service exposes a readiness route, configure `DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_HEALTH_ENDPOINT` or `DRAFT_CONNECTOR_UPSTREAM_HEALTH_ENDPOINT` so connector health and API preflight can detect an offline upstream before queueing work.
Set `DRAFT_CONNECTOR_<PLATFORM>_UPSTREAM_STATUS_ENDPOINT` when the connector should forward manual task sync requests to that upstream service and persist the returned remote draft state in the outbox; when connector health reports the upstream status service offline, or when the connector declares status credential forwarding but API-side `*_STATUS_INCLUDE_CREDENTIAL` is not enabled, sync is held as `needs_manual_action` before calling upstream.
External API proxies or automation workers can also call `POST /:platform/drafts/:draftId/status` on the connector to attach or refresh the real platform draft id and URL; the task sync action then updates the publish target from the local outbox URL to that external draft URL.
The API exposes connector readiness in `/runtime/status`, including each platform's `draftReady` flag, credential-forwarding requirement, readiness issue codes, and the connector contract URL, and the publish page shows whether each Zhihu/Bilibili/Xiaohongshu draft target is ready before creating connector-backed draft tasks.
The connector health response and API runtime status also expose per-platform outbox summaries and platform outbox URLs, including draft state counts, externalized draft counts, and stale publishing reservations that can resume upstream forwarding.
When a real draft target is not enabled, has no draft endpoint, uses an inferred local connector endpoint while that connector is offline, or declares an offline upstream health endpoint, the API marks that target as needing manual action before it reaches the worker queue.
Task details show target-level validation issues so connector preflight failures are visible without reading raw logs.
Retrying a real draft target reruns connector preflight first, so unresolved connector configuration issues stay in manual action instead of entering the worker queue.

Verify the local publishing chain after a build:

```bash
pnpm test:publish-flow
pnpm test:draft-connectors
```

This starts the built API and worker, creates a simulated publish task through HTTP, waits for BullMQ consumption, and checks that Postgres task state is updated successfully.
The draft connector test starts the built local draft connector and verifies workspace `.env` bootstrap, public-base runtime outbox links, the upstream contract endpoint, checker script, upstream sandbox script, automation service script, Playwright handler contract, work-order runner script including automation endpoint delegation, async upstream callback handoff, and upstream proxy enablement script, local enablement script output, three-platform disabled/missing-credential/credential-forwarding-mismatch/offline-connector/explicit-local-endpoint/offline-upstream preflight behavior, worker-side draft config drift manual-action handling, explicit local endpoint status inference, retry preflight queue protection, three-platform offline-upstream recovery after retry, connector readiness reporting, Zhihu/Bilibili/Xiaohongshu real-draft task results, idempotent connector draft reuse for repeated worker attempts, synchronous upstream draft forwarding, stale upstream forwarding reservation recovery, fresh in-flight reservation reuse without duplicate upstream calls, upstream rejection as manual action with local draft URLs, deduplicated manual status sync issues, status credential-forwarding mismatch sync protection, offline upstream status sync preflight, stale-link clearing on retry, and retry recovery, credential-gated upstream draft/status forwarding without outbox credential persistence, upstream status sync forwarding, browsable draft detail URLs, external draft URL handoff, outbox list entries, local outbox draft files, and manual status sync results when their connector endpoints are configured.

Required local services:

- PostgreSQL: stores accounts, documents, content versions, publish jobs, targets, attempts, worker state, and audit logs.
- Redis: backs the BullMQ queue consumed by `apps/worker`.

`pnpm infra:up` requires Docker Compose. If Docker is not available, run PostgreSQL and Redis yourself with the values from `.env.example`.
