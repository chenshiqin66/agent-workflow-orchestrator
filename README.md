# Agent Workflow Orchestrator

拖拽式智能体/流程编排系统（M1：画布 + 控制面草稿/发布；M2：Python 执行器 + 试运行时间线；M3：断点 / signal / 人工审批；M4：角色 / 资产注册表 / 发布门禁；M5：Subflow / 模板 / 薄指标）。

- **架构（方案 A）**：TypeScript 控制面 + 语言无关 Graph JSON + HTTP 执行器（回调）。
- **Monorepo**：`apps/web`（Vite + React + XYFlow）、`apps/control-plane`（Hono + Drizzle + PostgreSQL）、`apps/executor-py`（FastAPI）、`packages/graph-schema` / `packages/run-protocol`。
- **设计文档**：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`
- **M1 实现计划**：`docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`
- **M2 实现计划**：`docs/superpowers/plans/2026-10-21-m2-python-executor-test-run-timeline.md`
- **M3 设计 / 实现计划**：`docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md` · `docs/superpowers/plans/2026-10-22-m3-breakpoint-signal-human-approval.md`
- **M4 设计 / 实现计划**：`docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md` · `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md`
- **M5 设计 / 实现计划**：`docs/superpowers/specs/2026-10-22-m5-subflow-templates-metrics-design.md` · `docs/superpowers/plans/2026-10-22-m5-subflow-templates-metrics.md`
- **Run protocol 草图**：`docs/run-protocol-openapi.md`

## Prerequisites

- Node.js ≥ 20
- pnpm
- Docker（Postgres 16）
- Python ≥ 3.11（M2 executor）

## Local setup

### One command（推荐）

macOS / Linux / **WSL**：

```bash
pnpm dev:up
# 或: bash scripts/dev-up.sh
```

原生 Windows（PowerShell，需已装 Node / pnpm / Docker Desktop / Python ≥ 3.11）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-up.ps1
```

脚本会：检查依赖 → `pnpm install` → 启动 Postgres → migrate/seed → 准备 executor venv → 后台启动 API（`:8787`）、executor（`:8792`）、web（`:5173`）。日志与 PID 在 `.logs/`。浏览器打开 `http://localhost:5173`。

停止：

```bash
kill $(awk '{print $2}' .logs/pids.txt)
```

默认环境变量：`DATABASE_URL=postgres://awo:awo@localhost:5432/awo`、`EXECUTOR_TOKEN=dev`、`EXECUTOR_URL=http://127.0.0.1:8792`、`CALLBACK_BASE_URL=http://127.0.0.1:8787`、`PORT=8787`。Web 使用 `apps/web/.env`（缺省时从 `.env.example` 复制，`VITE_API_BASE=http://localhost:8787`）。

> 说明：`pnpm dev:executor` 仍默认 `:8790`；一键脚本为避免冲突改用 **8792**。

### Manual steps

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
| `X-User-Id` | HTTP header (stub auth) | Web user switcher: `u_admin` / `u_dev` / `u_builder` / `u_viewer`. OIDC deferred (post-M4). |

Copy `apps/web/.env.example` → `apps/web/.env` if you need a non-default API base.

## Packages

| Package | Role |
|---|---|
| `@awo/graph-schema` | Shared Zod graph + content hash |
| `@awo/run-protocol` | Run status / events / JobPayload / callback Zod |
| `@awo/control-plane` | REST: flows, publish gate, test-runs, assets, roles, signal/state/breakpoints, templates, metrics, executor callbacks |
| `@awo/web` | XYFlow canvas + 试运行 / SignalPanel / user switcher / node palette / assets / templates / metrics |
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

Out of scope for M2 (delivered in M3+): breakpoints / signals / HumanApproval; roles / assets / publish gate (M4); subflow / templates / metrics (M5); WS push (poll only); draft dry-run; mid-flight cancel in executor.

## M3 acceptance checklist

Requires control-plane + executor + web (same env as M2). Demo uses the **M3 sample** graph (`Start` → `Transform` → `Breakpoint` → `HumanApproval` → branches → `End`) loaded by default in the web app (`apps/web/src/sample-m3-graph.ts`).

1. **Breakpoint pause → patch → resume** — publish, 试运行; run hits `Breakpoint` (or a dynamic BP via canvas toggle / `PUT …/breakpoints`) → status `paused`, timeline shows `breakpoint_hit`. Edit state in the State editor (`PATCH …/state` → `state_patched`), then Resume (`POST …/signal` kind `resume` → `signal_received`) → run continues to succeed (or next pause).
2. **HumanApproval** — Approve takes the **success** edge; Reject takes **failure** (fallback `default` if no failure edge).
3. **Input** — when a graph includes an `Input` node, submitted values merge into state and appear in later emits / transforms.
4. **Cancel while paused** — Cancel → `cancelled` immediately; no further executor work.
5. **Polling** — timeline keeps polling through `paused`; stops only on terminal statuses.
6. **Integration test** — with Postgres up and executor deps installed:

```bash
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
export EXECUTOR_TOKEN=test-executor-token-m3
pnpm test:m3
```

`pnpm test:m2` must remain green after M3.

How to run the sample locally: start Postgres + migrate/seed, export `EXECUTOR_TOKEN` / `EXECUTOR_URL` / `CALLBACK_BASE_URL` / `DATABASE_URL`, then `pnpm dev:api`, `pnpm dev:executor`, `pnpm dev:web`. Open `http://localhost:5173`, publish the M3 demo flow, open 试运行, submit input, use SignalPanel / breakpoints as above.

Out of scope for M3: explicit `step` API, WebSocket/SSE push, multi-approver routing / SLA, M4 roles/assets/publish gate, M5 subflow/templates/metrics, draft dry-run.


## M4 acceptance checklist

Requires Postgres migrated (`0004_m4_roles_assets_gate`) + re-seeded demo users/assets. Stub auth remains `X-User-Id`.

**Roles** (rank: viewer=0 < builder=1 < developer=2 < admin=3):

| id | role |
|---|---|
| `u_admin` | admin |
| `u_dev` | developer |
| `u_builder` | builder |
| `u_viewer` | viewer |

1. **Node visibility** — Builder `GET /node-defs` omits `Code` / `Breakpoint`; developer+ sees them. Web palette loads filtered defs.
2. **Mutating guards** — Viewer cannot save draft / publish / create runs / signal (403). Builder can edit/publish/test published; only developer+ can `graph_source: "draft"` test-runs and asset writes.
3. **Assets** — `GET/POST/PATCH/DELETE /assets/tools|models|knowledge-bases`; seed samples `demo_echo` / `demo_stub` / `demo_kb`.
4. **Publish gate** — Before publish: `required_config` (e.g. HTTP needs `url`), `successful_test_run` (skipped on first publish / bootstrap), `role_nodes`. Failure → `400 { error: "publish_gate_failed", checks: [...] }`.
5. **Draft unlock** — After first publish, edit draft → publish blocked until a succeeded test-run matches the draft `schema_hash` (developer draft test-run is the intended path).
6. **Web** — User switcher, role-filtered palette, assets panel, gate errors in status line.
7. **Integration**:

```bash
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
export EXECUTOR_TOKEN=test-executor-token-m4
pnpm test:m4
```

`pnpm test:m2` and `pnpm test:m3` must remain green after M4.

Out of scope for M4: OIDC / SSO, secrets vault, multi-approver publish, M5 subflow/templates/metrics, WS push.

## Tests

```bash
pnpm test
# or per package:
pnpm --filter @awo/graph-schema test
pnpm --filter @awo/run-protocol test
pnpm --filter @awo/control-plane test   # needs DATABASE_URL
pnpm --filter @awo/web test
pnpm test:m2                            # control-plane + live executor happy path
pnpm test:m3                            # pause → signal → resume (live executor)
pnpm test:m4                            # roles / assets / publish gate
cd apps/executor-py && .venv/bin/python -m pytest
```

## License

Private / unpublished.


## M5 acceptance checklist

1. **Subflow expand** — parent draft with `Subflow.config.flow_version_id` pointing at a **published** same-workspace child; developer draft test-run succeeds; timeline shows prefixed child node ids (`sf__…`).
2. **Publish gate `subflow_refs`** — bad/missing child version → `400 publish_gate_failed` with check `subflow_refs`.
3. **Templates** — developer `POST /templates` from published version; builder `POST /templates/:id/clone` → new draft flow with copied nodes; Web「从模板创建」opens it.
4. **Thin metrics** — viewer `GET /metrics/flows/:id` and `/metrics/workspace`; UI「刷新指标」shows success_rate / avg_latency_ms / sum_cost_tokens.
5. **Regression** — `pnpm test:m5` green; `test:m2` / `test:m3` / `test:m4` still green. No CRDT / WS / metrics warehouse.

```bash
pnpm test:m5
```

