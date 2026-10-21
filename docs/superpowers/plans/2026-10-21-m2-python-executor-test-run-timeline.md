# M2 Python Executor + Test Run Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver test-run execution of a published `flow_version` via a Python executor, persist `runs` / `run_events`, and show a Run Timeline in the web UI (node status, IO payloads, seq order, duration).

**Architecture:** Control plane (Hono) creates a `runs` row for a **published** flow version, pushes an HTTP job to `apps/executor-py`, and receives HTTP callbacks that append `run_events` and update run status. Web polls run + events for the timeline (no WebSocket in M2). Shared Zod types live in `packages/run-protocol`. Graph remains language-agnostic JSON; secrets never appear in `graph_json` or executor job payloads beyond opaque refs (none required in M2).

**Tech Stack:** Existing M1 stack (TypeScript, pnpm, Hono, Drizzle, PostgreSQL, Vite, React, XYFlow, Vitest, Zod) plus Python 3.11+ (`httpx` or stdlib `urllib`, `pytest`), FastAPI or plain `http.server` / Starlette for the executor receive endpoint.

**Spec:** `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (M2 = Python executor + test run + run_events timeline)

## Global Constraints

- Product: 编排画布 + 运行时调试 — M2 ships **test run + timeline**; breakpoints/signals are M3
- Deploy shape: 前后端分离；Runtime 单独服务 (`apps/executor-py`)
- Auth: stub `X-User-Id` (unchanged); executor callbacks use shared secret header `X-Executor-Token` (env)
- Graph is language-agnostic JSON; secrets never inside `graph_json`
- **Only published** `flow_versions` may be test-run (aligns with immutable publish story). Draft dry-run is a stretch note only — do not implement
- Do not change M1 publish immutability rules
- Executor transport for M2: **HTTP push job + HTTP callback** (resolves open item; not gRPC)
- Timeline delivery for M2: **HTTP poll** (`GET /runs/:id` + `GET /runs/:id/events?after_seq=N`); WS/SSE deferred (stretch note)
- No real LLM API keys; optional `LLM` node is a fixed-text stub if encountered, otherwise M2 demo graphs avoid it
- M2 executable node set: `Start`, `End`, `Transform` (SetState alias), `Branch` (simple expression), `Emit`. Unknown types → fail the node with a clear error event (or skip with failure edge if configured — prefer hard fail for honesty)
- Seed/extend `node_defs` for `Transform` and `Emit` (and keep Start|End|Branch)
- Dual personas / roles / assets / publish gate → M4; Subflow/templates/metrics → M5

**Follow-up plans (do not implement in this plan):** M3 breakpoint/signal/human approval; M4 roles/assets/publish gate; M5 subflow/templates/metrics.

---

## Key architecture decisions (locked for M2)

| Decision | Choice | Rationale |
|---|---|---|
| Transport | Control plane **POSTs** job to executor `/v1/jobs`; executor **POSTs** events/status to control plane `/internal/runs/:id/events` and `/internal/runs/:id/status` | Spec open item; simplest local demo; no gRPC deps |
| Auth between services | `X-Executor-Token` shared secret (env `EXECUTOR_TOKEN`); internal routes skip `X-User-Id` | Stub-friendly; not a vault |
| Timeline | Client polls every 500–1000ms while status is `queued\|running` | Avoid Redis/WS for M2; still matches use case 8 + 10 |
| Test-run gate | Require `flow_versions.status === "published"` | Immutable publish story |
| Node subset | Start, End, Transform, Branch, Emit (+ LLM stub optional) | Enough for demo path without HTTP/HumanApproval |
| Branch expression | Restricted eval: `state.field == value` / truthy path lookup via `config.expression` or `config.path` + compare; **no** `eval()` of arbitrary Python | Safety |
| Transform | `config.assignments: { key: value \| { "$ref": "state.x" } }` merged into run state | Minimal SetState |
| Emit | Append `emit` event with `config.message` / payload; does not change control flow | Timeline visibility |
| Cancel | Optional `POST /runs/:id/cancel` sets status `cancel_requested`; executor checks between nodes | Nice-to-have; implement if time after happy path |
| Package layout | `packages/run-protocol` (TS Zod); `apps/executor-py` (Python, own `pyproject.toml`, not a pnpm package) | Matches monorepo; pnpm ignores dirs without `package.json` |

---

## File map (create / modify in M2)

```
agent-workflow-orchestrator/
  package.json                          # add scripts: dev:executor, test:m2
  docker-compose.yml                    # unchanged Postgres; optional comment only
  packages/run-protocol/
    package.json                        # @awo/run-protocol
    src/index.ts
    src/run.ts                          # Zod: RunStatus, RunEventType, JobPayload, CallbackEvent
    src/run.test.ts
  packages/graph-schema/                # unchanged except re-export if needed
  apps/control-plane/
    src/db/schema.ts                    # + runs, run_events
    src/db/seed.ts                      # + Transform, Emit node_defs
    drizzle/0002_runs.sql               # migration
    src/services/run-service.ts
    src/services/executor-client.ts     # HTTP push job
    src/routes/runs.ts                  # user-facing create/list/get/events/cancel
    src/routes/internal-runs.ts         # executor callbacks
    src/middleware/executor-auth.ts
    src/index.ts                        # mount routes; CORS already present
    tests/runs.test.ts
    tests/executor-callback.test.ts
  apps/executor-py/
    pyproject.toml
    README.md
    src/awo_executor/
      __init__.py
      main.py                           # HTTP server: POST /v1/jobs, GET /health
      engine.py                         # walk graph, emit events
      nodes.py                          # Start/End/Transform/Branch/Emit (+ llm_stub)
      expressions.py                    # safe branch expressions
      callback.py                       # POST events/status to control plane
    tests/test_engine.py
    tests/test_nodes.py
    tests/fixtures/minimal_graph.json
  apps/web/
    src/api/client.ts                   # + createTestRun, getRun, listRunEvents
    src/api/runs.test.ts
    src/run/TestRunPanel.tsx
    src/run/RunTimeline.tsx
    src/run/useRunPoll.ts
    src/App.tsx                         # wire panel after publish
    src/styles/run.css
    src/sample-m2-graph.ts              # Start→Transform→Branch→Emit→End
  docs/superpowers/specs/...design.md   # Status line += M2 plan path
  docs/run-protocol-openapi.md          # short OpenAPI sketch (optional companion)
```

---

### Task 1: `@awo/run-protocol` — Zod run + event types

**Files:**
- Create: `packages/run-protocol/package.json`, `packages/run-protocol/src/run.ts`, `packages/run-protocol/src/index.ts`, `packages/run-protocol/src/run.test.ts`
- Modify: root `pnpm-workspace.yaml` already covers `packages/*`

**Interfaces:**
- Consumes: none (standalone Zod)
- Produces:
  - `RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "cancel_requested"`
  - `RunEventType = "run_started" | "run_finished" | "node_started" | "node_finished" | "node_failed" | "emit" | "log"`
  - `JobPayload`: `{ run_id, flow_version_id, graph, input, callback_base_url, token }`
  - `CallbackEventBody`: `{ seq?, node_id?, event_type, payload, ts? }`
  - `parseJobPayload`, `parseCallbackEvent`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseJobPayload, parseCallbackEvent, RunStatusSchema } from "./index";

describe("run-protocol", () => {
  it("parses a minimal job payload", () => {
    const job = parseJobPayload({
      run_id: "run_1",
      flow_version_id: "fv_1",
      graph: {
        id: "fv_1",
        state_schema: { type: "object", properties: {} },
        nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
        edges: [],
      },
      input: { question: "hello" },
      callback_base_url: "http://localhost:8787",
      token: "secret",
    });
    expect(job.run_id).toBe("run_1");
  });

  it("rejects unknown run status", () => {
    expect(() => RunStatusSchema.parse("flying")).toThrow();
  });

  it("parses callback event", () => {
    const ev = parseCallbackEvent({
      event_type: "node_finished",
      node_id: "s",
      payload: { output: {}, duration_ms: 3 },
    });
    expect(ev.event_type).toBe("node_finished");
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
pnpm --filter @awo/run-protocol test
```

- [ ] **Step 3: Implement Zod schemas**

Keep graph shape as `z.record(z.unknown())` or import `FlowGraphSchema` from `@awo/graph-schema` (prefer dependency on `@awo/graph-schema` for one source of truth).

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/run-protocol
git commit -m "feat(run-protocol): add Zod types for jobs and run events"
```

---

### Task 2: DB — `runs` + `run_events` + seed Transform/Emit

**Files:**
- Modify: `apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/seed.ts`
- Create: `apps/control-plane/drizzle/0002_runs.sql` (or generate via drizzle-kit)
- Test: extend `apps/control-plane/tests/db-seed.test.ts` or add `tests/runs-schema.test.ts`

**Interfaces:**
- Consumes: existing Drizzle client
- Produces tables matching spec E-R:

`runs`:
- `id` text PK
- `flowVersionId` text not null
- `trigger` text not null (`test` | `prod` | `api`) — M2 only uses `test`
- `status` text not null
- `inputJson` jsonb not null
- `outputJson` jsonb nullable
- `errorMessage` text nullable
- `startedAt` timestamptz nullable
- `finishedAt` timestamptz nullable
- `costTokens` integer nullable default 0
- `createdBy` text not null
- `createdAt` timestamptz default now()

`run_events`:
- `id` text PK
- `runId` text not null
- `seq` integer not null
- `nodeId` text nullable
- `eventType` text not null
- `payloadJson` jsonb not null
- `ts` timestamptz not null default now()
- unique `(runId, seq)`

Seed: add `Transform`, `Emit` to `node_defs` (uiMeta rounded blue; category `data` / `debug`).

- [ ] **Step 1: Write failing seed/schema test** asserting `Transform` and `Emit` exist after seed; optionally insert a run row in a transaction and roll back

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Add Drizzle tables + migration + seed entries**

```bash
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/db apps/control-plane/drizzle
git commit -m "feat(control-plane): add runs and run_events tables"
```

---

### Task 3: Control-plane run service + user APIs

**Files:**
- Create: `apps/control-plane/src/services/run-service.ts`, `apps/control-plane/src/routes/runs.ts`
- Modify: `apps/control-plane/src/index.ts` (mount routes; allow `DELETE`/`POST` cancel in CORS if needed)
- Test: `apps/control-plane/tests/runs.test.ts`
- Deps: `@awo/run-protocol`

**Interfaces:**
- Consumes: `flow_versions` (published only), auth workspace check via existing project/flow ownership pattern
- Produces HTTP (user-facing, `X-User-Id`):
  - `POST /flows/:flowId/test-runs` body `{ input: object }` → creates run on **published** version; returns `{ id, status, flowVersionId }`; status starts `queued`
  - `GET /runs/:runId` → run metadata
  - `GET /flows/:flowId/runs` → recent runs (limit 20)
  - `GET /runs/:runId/events?after_seq=0` → `{ events: [...] }` ordered by `seq` ascending
  - `POST /runs/:runId/cancel` → optional; sets `cancel_requested` if `queued|running`

Rules:
1. Resolve flow in workspace; require `publishedVersionId`
2. Load published `flow_versions` row; reject `400` if missing or not `published`
3. Insert `runs` with `trigger=test`, `status=queued`, `inputJson`
4. Audit `run.test_create`
5. **Do not** call executor yet in this task — leave a `dispatchJob(runId)` hook / TODO called from Task 4 so tests can create runs without a live executor (or mock the client)

- [ ] **Step 1: Write failing API tests** (Hono `app.request`)

```ts
it("creates test run only against published version", async () => {
  const headers = { "X-User-Id": "u_dev", "Content-Type": "application/json" };
  // assume helper creates flow + draft + publish from M1 patterns
  const res = await app.request(`/flows/${flowId}/test-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { question: "hi" } }),
  });
  expect(res.status).toBe(201);
  const run = await res.json();
  expect(run.status).toBe("queued");

  const events = await app.request(`/runs/${run.id}/events`, { headers });
  expect(events.status).toBe(200);
  expect((await events.json()).events).toEqual([]);
});

it("rejects test run when nothing published", async () => {
  // flow with draft only
  const res = await app.request(`/flows/${draftOnlyFlowId}/test-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: {} }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement run-service + routes** (dispatch stubbed/no-op)

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control-plane): test-run CRUD and run_events list APIs"
```

---

### Task 4: Executor push client + internal callback routes

**Files:**
- Create: `apps/control-plane/src/services/executor-client.ts`, `apps/control-plane/src/middleware/executor-auth.ts`, `apps/control-plane/src/routes/internal-runs.ts`
- Modify: `apps/control-plane/src/services/run-service.ts` (call `dispatchJob` after insert), `apps/control-plane/src/index.ts`
- Test: `apps/control-plane/tests/executor-callback.test.ts`
- Env: `EXECUTOR_URL` (default `http://127.0.0.1:8790`), `EXECUTOR_TOKEN`, `CALLBACK_BASE_URL` (default `http://127.0.0.1:8787`)

**Interfaces:**
- Consumes: `JobPayload` from `@awo/run-protocol`
- Produces:
  - `dispatchJob(run)` → `POST ${EXECUTOR_URL}/v1/jobs` with job JSON; on network failure mark run `failed` + error event
  - Internal (header `X-Executor-Token`):
    - `POST /internal/runs/:runId/events` body callback event → assign next `seq`, insert `run_events`
    - `POST /internal/runs/:runId/status` body `{ status, output?, error_message? }` → update `runs`; set `startedAt`/`finishedAt` appropriately
  - Skip user `authMiddleware` for `/internal/*`; use `executorAuthMiddleware` instead
  - Seq allocation: transactional `max(seq)+1` per run (or counter on `runs` — prefer `max+1` in tx for M2 simplicity)

- [ ] **Step 1: Write failing callback tests** with forged token rejected; valid token appends seq 1,2,… and status transitions `queued → running → succeeded`

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement middleware, routes, executor-client (fetch); wire dispatch after create**

For unit tests without a live executor: inject `executorClient` or set `EXECUTOR_URL` to a mock; primary unit tests hit callbacks directly and mock `fetch` for dispatch.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control-plane): HTTP job dispatch and executor callbacks"
```

---

### Task 5: Python executor package — engine + nodes

**Files:**
- Create: entire `apps/executor-py/` tree listed in file map
- Test: `apps/executor-py/tests/test_engine.py`, `test_nodes.py`
- Fixture graph: Start → Transform (set `state.ok = true`) → Branch (`state.ok == true`) → Emit → End (success path); failure path End optional

**Interfaces:**
- Consumes: JobPayload JSON
- Produces: ordered callbacks:
  1. status `running`
  2. `run_started`
  3. per node: `node_started` → work → `node_finished` or `node_failed` (payload includes `input` snapshot, `output`, `duration_ms`)
  4. `Emit` also sends `event_type: "emit"`
  5. status `succeeded` or `failed` with `output` / `error_message`
- HTTP: `GET /health` → `{ ok: true }`; `POST /v1/jobs` → `202` immediately, execute in background thread/asyncio task
- Verify `Authorization`/`X-Executor-Token` matches job token or server env

Node semantics:

| Type | Behavior |
|---|---|
| `Start` | Copy job `input` into `state`; output = state |
| `Transform` | Apply `config.assignments` into state |
| `Branch` | Evaluate expression; choose outgoing edge `kind=success` if true else `failure`; if missing edge, fail |
| `Emit` | Emit event with message; follow `default`/`success` out |
| `End` | Mark terminal; run output = state |
| `LLM` (optional stub) | Set `state.llm_text = config.stub_text \|\| "stub"` — no network |
| other | `node_failed` with `unsupported_node_type` |

Expression safety (`expressions.py`): allow only:
- `state.<ident>` path reads
- comparisons `==`, `!=`, `>`, `<`, `>=`, `<=`
- boolean literals / `and`/`or`/`not` with parentheses
- Reject attribute access beyond `state`, calls, imports, subscripts with expressions other than string/int literals if needed

- [ ] **Step 1: Write failing pytest for fixture graph happy path** (mock callback client collecting events)

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/executor-py && python -m pytest
```

- [ ] **Step 3: Implement nodes + engine + callback client + main HTTP server**

Prefer FastAPI + uvicorn if already comfortable; otherwise Starlette or stdlib is fine. Document start command in package README:

```bash
EXECUTOR_TOKEN=dev CALLBACK_BASE_URL=http://127.0.0.1:8787 \
  uvicorn awo_executor.main:app --port 8790
```

- [ ] **Step 4: Run pytest — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/executor-py
git commit -m "feat(executor-py): minimal graph engine and HTTP job server"
```

---

### Task 6: Integration test — control-plane + executor happy path

**Files:**
- Create: `apps/control-plane/tests/m2-integration.test.ts` (or `scripts/m2-smoke.sh` + vitest)
- Modify: root `package.json` scripts `"test:m2": "..."` 

**Interfaces:**
- Consumes: live Postgres, control-plane `app`, executor process (spawn or assume `EXECUTOR_URL`)
- Produces: one automated happy path **without real LLM**

Recommended approach (reliable in CI):
1. Start executor in-process via child_process in `beforeAll`, or use pure Python pytest that POSTs into a test double
2. Prefer **Vitest integration** that:
   - Uses Hono app + real DB
   - Mocks outbound `fetch` to executor by **invoking the Python engine synchronously** via `python -c` OR starts uvicorn on ephemeral port
3. Minimum bar if process spawn is flaky: control-plane callback unit tests (Task 4) + Python engine tests (Task 5) + a documented manual smoke; still add one integration test that drives callbacks as the executor would (synthetic) **and** one Python test that posts to a mock HTTP callback server (`http.server`)

**Required assertion path:**
1. Publish graph (Start→Transform→Branch→Emit→End)
2. `POST test-runs` with `{ input: { flag: true } }`
3. Wait until run `succeeded` (poll or await executor)
4. Events contain increasing `seq`, include `node_finished` for each node, one `emit`, final status succeeded
5. `output_json` reflects transformed state

- [ ] **Step 1: Write failing integration test**

- [ ] **Step 2: Run — expect FAIL** (until executor wired)

- [ ] **Step 3: Fix wiring / flake (timeouts, token env)**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "test: M2 control-plane + executor happy path"
```

---

### Task 7: Web — Test Run panel + Run Timeline

**Files:**
- Create: `apps/web/src/run/TestRunPanel.tsx`, `RunTimeline.tsx`, `useRunPoll.ts`, `styles/run.css`, `sample-m2-graph.ts`
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/App.tsx`
- Test: `apps/web/src/api/runs.test.ts`, optional `useRunPoll` pure helper test

**Interfaces:**
- Consumes: Task 3 HTTP APIs
- Produces UI:
  - **Test Run panel** (side or bottom): JSON input textarea (default `{"question":"demo"}`), **试运行** button enabled only when `publishedVersionId` set; shows run id + status badge
  - **Run Timeline**: list events by `seq`; each row shows time, node id/type if known, event type, duration from payload, expandable IO JSON
  - Optional: highlight XYFlow node by `data-status` from latest events (nice-to-have; implement if panel done early)
  - Poll every 750ms while status in `queued|running|cancel_requested`; stop on terminal

`client.ts` additions:

```ts
createTestRun(flowId: string, input: unknown)
getRun(runId: string)
listRunEvents(runId: string, afterSeq?: number)
cancelRun(runId: string) // optional
```

Wire App:
- After publish success, panel unlocks
- Provide button to load `sample-m2-graph` into canvas for demo (or replace create-flow seed)

- [ ] **Step 1: Write client mock-fetch tests for createTestRun / listRunEvents**

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement client + panel + timeline + CSS (light blue/white consistent with canvas)**

- [ ] **Step 4: Run unit tests — PASS; manual smoke:**

```bash
pnpm db:up
pnpm --filter @awo/control-plane db:migrate && pnpm --filter @awo/control-plane db:seed
EXECUTOR_TOKEN=dev EXECUTOR_URL=http://127.0.0.1:8790 CALLBACK_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @awo/control-plane dev
# other terminal:
cd apps/executor-py && EXECUTOR_TOKEN=dev uvicorn awo_executor.main:app --port 8790
pnpm --filter @awo/web dev
```

Checklist:
1. Create/open flow → paste/load M2 sample → Save → Publish
2. 试运行 with sample input
3. Timeline fills in order; statuses flip to succeeded
4. Refresh events via poll without duplicate rows (`after_seq`)

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): test run panel and run timeline UI"
```

---

### Task 8: Docs — OpenAPI sketch, README, spec status

**Files:**
- Create: `docs/run-protocol-openapi.md` (sketch paths from Tasks 3–4 + executor `/v1/jobs`)
- Modify: `README.md` (M2 section: how to run executor + test run)
- Modify: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` Status line to include M2 plan path
- Modify: spec §12 open item “First executor transport” → resolved as HTTP callback for M2

- [ ] **Step 1: Update design spec Status**

```
- Status: approved; M1 plan in `docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`; M2 plan in `docs/superpowers/plans/2026-10-21-m2-python-executor-test-run-timeline.md`
```

- [ ] **Step 2: Write OpenAPI sketch + README M2 acceptance checklist**

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: M2 run protocol sketch and README acceptance"
```

---

## Spec coverage (self-review)

| Spec item | Plan task |
|---|---|
| M2 Python executor + test run + run_events timeline | Tasks 1–8 |
| E-R `runs` / `run_events` | Task 2 |
| Run API create / cancel | Task 3 |
| Executor HTTP push + event callbacks | Tasks 4–5 |
| Canvas trigger试运行 + timeline | Task 7 |
| Graph JSON language-agnostic | unchanged; job embeds published graph |
| HTTP vs gRPC open item | Locked HTTP in this plan |
| Breakpoints / signals / HumanApproval | Out of scope → M3 |
| Roles / assets / publish gate | Out of scope → M4 |
| Subflow / templates / metrics | Out of scope → M5 |
| Real LLM / secrets vault | Out of scope |
| Draft test-run | Explicitly deferred (stretch only) |
| WS timeline push | Deferred; poll in M2 |

## Placeholder / consistency check

- IDs: `u_dev`, `p_demo`, `ws_demo` unchanged
- Ports: control-plane `8787`, web `5173`, executor `8790`
- Env: `EXECUTOR_URL`, `EXECUTOR_TOKEN`, `CALLBACK_BASE_URL`, `DATABASE_URL`, `X-User-Id`
- Event `seq` monotonic per `run_id` starting at 1
- No TBD steps; cancel is optional but API shape specified
- M2 sample graph must not require HTTP/HumanApproval nodes for the happy-path demo

## Stretch (explicitly optional — skip unless ahead of schedule)

- SSE endpoint `GET /runs/:id/stream` as alternative to poll
- Canvas node glow by live status
- Draft dry-run that never marks `trigger=prod` and stamps `draft_version_id` (still prefer published-only)
- `POST /runs/:id/cancel` honored mid-flight in executor

---

## Execution handoff

After this plan is approved for execution, choose:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — execute in this session with checkpoints

Start at Task 1. Do not implement M3+ items from this plan.
