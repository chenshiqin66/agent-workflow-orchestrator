# Agent Workflow Orchestrator

拖拽式智能体/流程编排系统（M1：画布 + 控制面草稿/发布）。

- **架构（方案 A）**：TypeScript 控制面 + 语言无关 Graph JSON；执行器从 M2 起。
- **Monorepo**：`apps/web`（Vite + React + XYFlow）、`apps/control-plane`（Hono + Drizzle + PostgreSQL）、`packages/graph-schema`（Zod 图模型）。
- **设计文档**：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`
- **M1 实现计划**：`docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`

## Prerequisites

- Node.js ≥ 20
- pnpm
- Docker（Postgres 16）

## Local setup

```bash
# 1. Install
pnpm install

# 2. Start Postgres (localhost:5432, db/user/pass awo/awo/awo)
pnpm db:up

# 3. Migrate + seed demo user/workspace/project/node_defs
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed

# 4. API (default :8787)
pnpm dev:api

# 5. Web (default :5173) — new terminal
pnpm dev:web
```

Open `http://localhost:5173`.

### Environment notes

| Variable | Where | Default / notes |
|---|---|---|
| `DATABASE_URL` | control-plane | Required for migrate/seed/dev; e.g. `postgres://awo:awo@localhost:5432/awo` |
| `PORT` | control-plane | `8787` |
| `VITE_API_BASE` | web | `http://localhost:8787` (see `apps/web/.env.example`) |
| `X-User-Id` | HTTP header (stub auth) | Web client sends `u_dev` (seeded developer). Real OIDC arrives in M4. |

Copy `apps/web/.env.example` → `apps/web/.env` if you need a non-default API base.

## Packages

| Package | Role |
|---|---|
| `@awo/graph-schema` | Shared Zod graph + content hash |
| `@awo/control-plane` | REST: flows, draft save, immutable publish |
| `@awo/web` | XYFlow canvas (style aligned to reference screenshot) |

## M1 acceptance checklist

Manual smoke (API + UI) after setup:

1. **Create / open demo flow** — use「新建演示流程」or reload a remembered flow under project `p_demo`.
2. **Edit graph** —「添加 Branch」, connect **success** / **failure** edges with labels (blue / red-orange paths).
3. **Save draft → refresh → restored** —「保存草稿」, reload the page; graph nodes/edges come back from the server.
4. **Publish immutability** —「发布」sets `publishedVersionId`; further edits + save create a **new** draft (`versionId` / `schemaHash` change) and **do not** mutate the published `flow_versions` row. Publish always saves the current canvas draft first.

Out of scope for M1: runtime executor, breakpoints, roles/assets publish gate, subflow/templates (M2–M5).

## Tests

```bash
pnpm test
# or per package:
pnpm --filter @awo/graph-schema test
pnpm --filter @awo/control-plane test   # needs DATABASE_URL
pnpm --filter @awo/web test
```

## License

Private / unpublished.
