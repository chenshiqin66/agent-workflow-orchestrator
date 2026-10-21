# Agent Workflow Orchestrator

拖拽式智能体/流程编排系统（M1：画布 + 控制面草稿/发布；M2：Python 执行器 + 试运行时间线）。

- **架构（方案 A）**：TypeScript 控制面 + 语言无关 Graph JSON + HTTP 执行器（回调）。
- **Monorepo**：`apps/web`（Vite + React + XYFlow）、`apps/control-plane`（Hono + Drizzle + PostgreSQL）、`apps/executor-py`（FastAPI）、`packages/graph-schema` / `packages/run-protocol`。
- **设计文档**：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`
- **M1 实现计划**：`docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`
- **M2 实现计划**：`docs/superpowers/plans/2026-10-21-m2-python-executor-test-run-timeline.md`
- **Run protocol 草图**：`docs/run-protocol-openapi.md`

## Prerequisites

- Node.js ≥ 20
- pnpm
- Docker（Postgres 16）
- Python ≥ 3.11（M2 executor）

## Local setup

```bash
# 1. Install JS workspace
pnpm install

# 2. Start Postgres (localhost:5432, db/user/pass awo/awo/awo)
pnpm db:up

# 3. Migrate + seed demo user/workspace/project/node_defs
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed

# 4. Python executor venv (once)
cd apps/executor-py && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && cd ../..

# 5. Shared secret for control-plane ↔ executor
export EXECUTOR_TOKEN=dev
export EXECUTOR_URL=http://127.0.0.1:8790
export CALLBACK_BASE_URL=http://127.0.0.1:8787
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo

# 6. Three processes (separate terminals)
pnpm dev:api          # control-plane :8787
pnpm dev:executor     # FastAPI executor :8790 (needs EXECUTOR_TOKEN)
pnpm dev:web          # Vite :5173
```

Open `http://localhost:5173`.

### Environment notes

| Variable | Where | Default / notes |
|---|---|---|
| `DATABASE_URL` | control-plane | Required; e.g. `postgres://awo:awo@localhost:5432/awo` |
| `PORT` | control-plane | `8787` |
| `EXECUTOR_URL` | control-plane | `http://127.0.0.1:8790` — where jobs are POSTed |
| `EXECUTOR_TOKEN` | control-plane **and** executor | Required shared secret; dispatch fails if unset on control-plane |
| `CALLBACK_BASE_URL` | control-plane (embedded in job) | `http://127.0.0.1:8787` — executor callbacks |
| `VITE_API_BASE` | web | `http://localhost:8787` (see `apps/web/.env.example`) |
| `X-User-Id` | HTTP header (stub auth) | Web sends `u_dev`. Real OIDC in M4. |

Copy `apps/web/.env.example` → `apps/web/.env` if you need a non-default API base.

## Packages

| Package | Role |
|---|---|
| `@awo/graph-schema` | Shared Zod graph + content hash |
| `@awo/run-protocol` | Run status / events / JobPayload / callback Zod |
| `@awo/control-plane` | REST: flows, publish, test-runs, event poll, executor callbacks |
| `@awo/web` | XYFlow canvas + 试运行 panel / timeline |
| `apps/executor-py` | Python graph engine + `POST /v1/jobs` |

## M1 acceptance checklist

Manual smoke (API + UI) after setup:

1. **Create / open demo flow** — use「新建演示流程」or reload a remembered flow under project `p_demo`.
2. **Edit graph** —「添加 Branch」, connect **success** / **failure** edges with labels (blue / red-orange paths).
3. **Save draft → refresh → restored** —「保存草稿」, reload the page; graph nodes/edges come back from the server.
4. **Publish immutability** —「发布」sets `publishedVersionId`; further edits + save create a **new** draft (`versionId` / `schemaHash` change) and **do not** mutate the published `flow_versions` row. Publish always saves the current canvas draft first.

## M2 acceptance checklist

Requires control-plane + executor + web (env above). Happy-path graph uses `Start` / `Transform` / `Branch` / `Emit` / `End` only (no HTTP/HumanApproval).

1. **Publish first** — canvas「试运行」needs a published version; unpublished flows get a clear error.
2. **Start test run** — open 试运行 panel, submit JSON `input`, create run (`POST /flows/:id/test-runs`).
3. **Timeline polls** — events appear with monotonic `seq` (`run_started` → node events → `run_finished`); status moves `queued` → `running` → `succeeded` (or `failed`).
4. **Executor round-trip** — control-plane POSTs `JobPayload` to `EXECUTOR_URL/v1/jobs`; executor POSTs `/internal/runs/:id/events` and `/status` with `X-Executor-Token`.
5. **Integration test** — with Postgres up and executor deps installed:

```bash
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
export EXECUTOR_TOKEN=test-executor-token-m2
pnpm test:m2
```

Out of scope for M2 (later milestones): breakpoints / signals / HumanApproval (M3), roles / assets / publish gate (M4), subflow / templates / metrics (M5), WS push (poll only), draft dry-run, mid-flight cancel in executor.

## Tests

```bash
pnpm test
# or per package:
pnpm --filter @awo/graph-schema test
pnpm --filter @awo/run-protocol test
pnpm --filter @awo/control-plane test   # needs DATABASE_URL
pnpm --filter @awo/web test
pnpm test:m2                            # control-plane + live executor happy path
cd apps/executor-py && .venv/bin/python -m pytest
```

## License

Private / unpublished.
