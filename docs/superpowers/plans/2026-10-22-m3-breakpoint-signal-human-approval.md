# M3 Breakpoint / Signal / Human Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the debug/approval loop on top of M2: dynamic breakpoints and `Breakpoint` nodes pause a run; `HumanApproval` / `Input` wait for user signals; paused runs persist a checkpoint and resume via re-dispatch without holding an executor worker.

**Architecture:** Checkpoint resume (stateless executor jobs). On pause the executor emits `breakpoint_hit` or `waiting_signal` (payload includes a `Checkpoint`), the control plane sets `runs.status=paused` and stores `checkpoint_json` / `pause_reason`, then the job ends. User `signal` / `PATCH state` / `PUT breakpoints` update the run; resume re-dispatches the same published graph with `checkpoint` (+ active `breakpoints`). Web keeps HTTP polling through `paused` and shows a SignalPanel. No WebSocket, no explicit step API, published-only test runs unchanged.

**Tech Stack:** Existing M1/M2 stack — TypeScript, pnpm, Hono, Drizzle, PostgreSQL, Vite, React, XYFlow, Vitest, Zod; Python 3.11+ executor (`awo_executor`), pytest. Paths use `apps/control-plane` (not `apps/api`).

**Spec:** `docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md`

## Global Constraints

- Product: 编排画布 + 运行时调试 — M3 ships **breakpoint + signal + HumanApproval/Input**; roles/assets/publish gate are M4; subflow/templates/metrics are M5
- Resume model: **checkpoint re-dispatch only** (not in-process wait, not per-node CP scheduler)
- Deploy shape: 前后端分离；Runtime 仍是 `apps/executor-py`
- Auth: stub `X-User-Id`; executor callbacks `X-Executor-Token` (env `EXECUTOR_TOKEN`) — unchanged
- Graph is language-agnostic JSON; secrets never inside `graph_json`
- **Only published** `flow_versions` may be test-run (M2 rule; do not add draft dry-run)
- Do not change M1 publish immutability rules
- Timeline delivery: **HTTP poll** (keep; do not stop on `paused`; stop only on terminal)
- No explicit `step` API; temporary next-node breakpoint is enough later
- No real multi-approver routing / SLA / email notify
- No real LLM; AST-safe Branch only
- Migration name exact: `0003_m3_pause_signal`
- Dynamic breakpoints: pause **BEFORE entering** node id listed in `job.breakpoints`
- `Breakpoint` node: **enter then pause**; on `resume`, **skip re-entry** and follow outgoing edge
- Seq assignment remains server-side monotonic (M2)
- Cancel while `paused` → `cancelled` immediately (no re-dispatch); do not leave `cancel_requested` stuck on a paused run with no worker

**Follow-up plans (do not implement in this plan):** M4 roles/assets/publish gate; M5 subflow/templates/metrics; WS/SSE push; explicit step API.

---

## Key architecture decisions (locked for M3)

| Decision | Choice | Rationale |
|---|---|---|
| Resume | Persist checkpoint; end job; re-dispatch with `JobPayload.checkpoint` | Spec; survives executor restart; language-agnostic |
| Pause signal path | Pause events carry `checkpoint` in payload; internal `/events` handler sets `paused` | One callback path; no `/pause` endpoint |
| Status after pause | `paused` (not terminal); `finishedAt` stays null | Spec RunStatus |
| Status on resume dispatch | Set `queued`, then executor posts `running` | Matches M2 create flow |
| Dynamic BP | Before `node_started` / execute; checkpoint `node_id` = that node; `pause_kind=breakpoint` | Spec |
| Breakpoint node | Run as no-op transform that forces pause after “enter”; resume skips re-entry | Spec |
| HumanApproval resume | `approve` → `resume_edge_kind=success`; `reject` → `failure` (fallback `default`); do not re-run side effects | Spec |
| Input resume | Merge `payload` into checkpoint state as `pending_input` / state; continue on default/success out | Spec |
| Invalid signal | `400` if kind mismatches `pause_reason` | Spec |
| Breakpoints scope | Active run only (`run_breakpoints`); included on every dispatch / re-dispatch | Spec M3 minimum |
| Cancel from paused | Direct `cancelled` + `finishedAt`; append `log` optional | Spec acceptance #4 |

---

## File map (create / modify in M3)

```
agent-workflow-orchestrator/
  package.json                              # + script test:m3
  packages/run-protocol/
    src/run.ts                              # + paused, new events, Checkpoint, JobPayload fields
    src/run.test.ts
    src/index.ts                            # re-exports
  apps/control-plane/
    src/db/schema.ts                        # runs.+checkpoint/pause; run_breakpoints; run_signals
    src/db/seed.ts                          # + HumanApproval, Input, Breakpoint node_defs
    drizzle/0003_m3_pause_signal.sql
    src/services/run-service.ts             # signal, patchState, breakpoints, cancel-from-paused, getRun fields
    src/services/executor-client.ts         # include checkpoint + breakpoints in JobPayload
    src/routes/runs.ts                      # new routes
    src/routes/internal-runs.ts             # pause-on-event; accept status paused
    tests/runs-schema.test.ts               # extend
    tests/runs.test.ts                      # signal/state/breakpoints unit
    tests/executor-callback.test.ts         # pause event → paused
    tests/m3-integration.test.ts            # live executor pause→signal→resume
  apps/executor-py/
    src/awo_executor/engine.py              # breakpoints, checkpoint resume, pause exit
    src/awo_executor/nodes.py               # Breakpoint, HumanApproval, Input (+ NodeResult.pause)
    tests/test_engine.py                    # resume + BP cases
    tests/test_nodes.py                     # new node handlers
    tests/fixtures/m3_approval_graph.json   # optional fixture
  apps/web/
    src/api/client.ts                       # signal, patchRunState, get/putBreakpoints; RunStatus+paused; RunDetail fields
    src/api/runs.test.ts                    # extend
    src/run/useRunPoll.ts                   # ACTIVE includes paused
    src/run/useRunPoll.test.ts
    src/run/SignalPanel.tsx                 # Approve/Reject/Input/Resume
    src/run/StateEditor.tsx                 # JSON edit while paused
    src/run/RunTimeline.tsx                 # new event labels
    src/run/TestRunPanel.tsx                # wire pause UI
    src/run/BreakpointToggle.tsx            # or canvas context menu helper
    src/sample-m3-graph.ts                  # HumanApproval + Breakpoint demo
    src/App.tsx                             # load M3 sample; breakpoint toggles
    src/styles/run.css                      # pause banner
  docs/run-protocol-openapi.md              # M3 paths + resume rules
  README.md                                 # M3 section
  docs/superpowers/specs/2026-10-22-m3-...  # Status → approved + plan path
  docs/superpowers/specs/2026-10-21-...     # Status += M3 plan path
```

---

### Task 1: `@awo/run-protocol` — paused, events, Checkpoint, JobPayload

**Files:**
- Modify: `packages/run-protocol/src/run.ts`, `packages/run-protocol/src/index.ts`
- Test: `packages/run-protocol/src/run.test.ts`

**Interfaces:**
- Consumes: existing `FlowGraphSchema` import
- Produces (extend, keep backward compatible required fields):
  - `RunStatus` += `"paused"`
  - `RunEventType` += `"breakpoint_hit" | "waiting_signal" | "signal_received" | "state_patched"`
  - `PauseKindSchema` = `"breakpoint" | "approval" | "input"`
  - `CheckpointSchema` / `Checkpoint`:
    ```ts
    {
      node_id: string;
      state: Record<string, unknown>;
      pause_kind: "breakpoint" | "approval" | "input";
      resume_edge_kind?: "success" | "failure" | "default";
      pending_input?: Record<string, unknown>;
    }
    ```
  - `JobPayload` += optional `checkpoint?: Checkpoint`, `breakpoints?: string[]`
  - `SignalKindSchema` (API body helper, optional export) = `"approve" | "reject" | "input" | "resume"`
  - Existing `parseJobPayload` / `parseCallbackEvent` must accept pause events and jobs with checkpoint

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import {
  RunStatusSchema,
  RunEventTypeSchema,
  CheckpointSchema,
  parseJobPayload,
  parseCallbackEvent,
} from "./index";

describe("run-protocol M3", () => {
  it("accepts paused status", () => {
    expect(RunStatusSchema.parse("paused")).toBe("paused");
  });

  it("accepts new event types", () => {
    for (const t of [
      "breakpoint_hit",
      "waiting_signal",
      "signal_received",
      "state_patched",
    ] as const) {
      expect(RunEventTypeSchema.parse(t)).toBe(t);
    }
  });

  it("parses job with checkpoint and breakpoints", () => {
    const job = parseJobPayload({
      run_id: "run_1",
      flow_version_id: "fv_1",
      graph: {
        id: "fv_1",
        state_schema: { type: "object", properties: {} },
        nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
        edges: [],
      },
      input: {},
      callback_base_url: "http://localhost:8787",
      token: "secret",
      breakpoints: ["n_transform"],
      checkpoint: {
        node_id: "n_transform",
        state: { flag: true },
        pause_kind: "breakpoint",
      },
    });
    expect(job.breakpoints).toEqual(["n_transform"]);
    expect(job.checkpoint?.pause_kind).toBe("breakpoint");
  });

  it("parses breakpoint_hit callback with checkpoint payload", () => {
    const ev = parseCallbackEvent({
      event_type: "breakpoint_hit",
      node_id: "n_transform",
      payload: {
        checkpoint: {
          node_id: "n_transform",
          state: { a: 1 },
          pause_kind: "breakpoint",
        },
      },
    });
    expect(ev.event_type).toBe("breakpoint_hit");
    expect(CheckpointSchema.parse(ev.payload.checkpoint).node_id).toBe(
      "n_transform",
    );
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
pnpm --filter @awo/run-protocol test
```

Expected: FAIL (unknown enum members / missing `CheckpointSchema`).

- [ ] **Step 3: Implement schemas in `run.ts`**

```ts
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "cancel_requested",
]);

export const RunEventTypeSchema = z.enum([
  "run_started",
  "run_finished",
  "node_started",
  "node_finished",
  "node_failed",
  "emit",
  "log",
  "breakpoint_hit",
  "waiting_signal",
  "signal_received",
  "state_patched",
]);

export const PauseKindSchema = z.enum(["breakpoint", "approval", "input"]);
export const ResumeEdgeKindSchema = z.enum(["success", "failure", "default"]);

export const CheckpointSchema = z.object({
  node_id: z.string().min(1),
  state: z.record(z.unknown()),
  pause_kind: PauseKindSchema,
  resume_edge_kind: ResumeEdgeKindSchema.optional(),
  pending_input: z.record(z.unknown()).optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const JobPayloadSchema = z.object({
  run_id: z.string().min(1),
  flow_version_id: z.string().min(1),
  graph: FlowGraphSchema,
  input: z.record(z.unknown()),
  callback_base_url: z.string().min(1),
  token: z.string().min(1),
  checkpoint: CheckpointSchema.optional(),
  breakpoints: z.array(z.string().min(1)).optional(),
});

export const SignalKindSchema = z.enum([
  "approve",
  "reject",
  "input",
  "resume",
]);
```

Re-export new symbols from `src/index.ts`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/run-protocol
git commit -m "feat(run-protocol): add paused status, pause events, and Checkpoint"
```

---

### Task 2: DB — `0003_m3_pause_signal` + seed HumanApproval / Input / Breakpoint

**Files:**
- Modify: `apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/seed.ts`
- Create: `apps/control-plane/drizzle/0003_m3_pause_signal.sql` (and update `drizzle/meta` if using drizzle-kit generate; hand-written SQL is fine if consistent with `0002_runs.sql`)
- Test: `apps/control-plane/tests/runs-schema.test.ts` (extend), `apps/control-plane/tests/db-seed.test.ts` if present

**Interfaces:**
- Consumes: existing Drizzle `runs` / `run_events`
- Produces:

`runs` columns added:
- `checkpointJson` → `checkpoint_json` jsonb nullable
- `pauseReason` → `pause_reason` text nullable (`breakpoint` | `approval` | `input`)

`run_breakpoints`:
- `id` text PK
- `runId` text not null
- `nodeId` text not null
- `active` integer not null default 1 (1=active, 0=inactive) — avoid new boolean column type drift vs M1/M2 text/int style
- unique `(runId, nodeId)`

`run_signals`:
- `id` text PK
- `runId` text not null
- `kind` text not null (`approval` | `input` | `resume`) — store approve/reject under `approval` with outcome in `payload_json`
- `payloadJson` jsonb not null
- `status` text not null (`pending` | `consumed` | `rejected`)
- `createdAt` timestamptz default now()

Seed `node_defs` for workspace `ws_demo`:
- `HumanApproval` — category `control`, uiMeta orange
- `Input` — category `control`, uiMeta orange/teal
- `Breakpoint` — category `debug`, uiMeta red/orange

SQL sketch (`0003_m3_pause_signal.sql`):

```sql
ALTER TABLE "runs" ADD COLUMN "checkpoint_json" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pause_reason" text;
--> statement-breakpoint
CREATE TABLE "run_breakpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "node_id" text NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "run_breakpoints_run_id_node_id_unique" UNIQUE("run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "run_signals" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "kind" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

- [ ] **Step 1: Write failing schema/seed tests**

```ts
it("runs table exposes checkpoint_json and pause_reason columns in schema export", () => {
  expect(runs.checkpointJson).toBeDefined();
  expect(runs.pauseReason).toBeDefined();
});

it("run_breakpoints and run_signals tables are defined", () => {
  expect(runBreakpoints.runId).toBeDefined();
  expect(runSignals.kind).toBeDefined();
});

it("seed includes HumanApproval, Input, Breakpoint", async () => {
  // after seed against test DB
  const keys = await db.select({ typeKey: nodeDefs.typeKey }).from(nodeDefs);
  const set = new Set(keys.map((k) => k.typeKey));
  expect(set.has("HumanApproval")).toBe(true);
  expect(set.has("Input")).toBe(true);
  expect(set.has("Breakpoint")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @awo/control-plane exec vitest run tests/runs-schema.test.ts tests/db-seed.test.ts
```

- [ ] **Step 3: Add Drizzle tables + migration + seed entries**

```bash
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/db apps/control-plane/drizzle apps/control-plane/tests
git commit -m "feat(control-plane): M3 pause columns, breakpoints, and signals tables"
```

---

### Task 3: Control-plane — pause on events, signal / state / breakpoints, re-dispatch

**Files:**
- Modify: `apps/control-plane/src/services/run-service.ts`, `apps/control-plane/src/services/executor-client.ts`, `apps/control-plane/src/routes/runs.ts`, `apps/control-plane/src/routes/internal-runs.ts`
- Test: `apps/control-plane/tests/runs.test.ts`, `apps/control-plane/tests/executor-callback.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 tables; existing `dispatchJob` / `pushJobToExecutor`
- Produces HTTP (user-facing, `X-User-Id`):

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/runs/:runId/signal` | `{ kind: "approve"\|"reject"\|"input"\|"resume", payload?: object }` — only `paused`; emits `signal_received`; updates checkpoint; re-dispatch |
| `PATCH` | `/runs/:runId/state` | `{ state: object }` full replace **or** `{ patch: object }` shallow merge — only `paused`; updates `checkpoint_json.state`; emits `state_patched` |
| `PUT` | `/runs/:runId/breakpoints` | `{ node_ids: string[] }` — upsert rows, set `active=1` for listed, `active=0` for others on this run |
| `GET` | `/runs/:runId/breakpoints` | `{ node_ids: string[] }` active only |
| `POST` | `/runs/:runId/cancel` | allow from `paused` → set `cancelled` + `finishedAt` (not `cancel_requested`) |

`GET /runs/:runId` adds:
- `pauseReason: string | null`
- `checkpoint: Checkpoint | null` (parsed from `checkpoint_json`)

Internal `/internal/runs/:runId/events`:
- After insert, if `event_type` is `breakpoint_hit` or `waiting_signal`:
  - Require `payload.checkpoint` parseable as `Checkpoint`
  - Update run: `status=paused`, `checkpoint_json=checkpoint`, `pause_reason=checkpoint.pause_kind`, clear `finishedAt` if any
- Do **not** treat `paused` as terminal in status handler; accepting `status: "paused"` is optional belt-and-suspenders (if executor also posts it). Prefer event-driven pause as source of truth.

`pushJobToExecutor(runId)`:
- Load active breakpoints (`active=1`) → `breakpoints: string[]`
- If `run.checkpointJson` present and status is `queued` (resume path), include `checkpoint`
- On first create, checkpoint is null

Signal semantics in `signalRun(...)`:

```ts
// pseudo
assert status === "paused"
const cp = CheckpointSchema.parse(run.checkpointJson)
const reason = run.pauseReason

if (kind === "resume") {
  if (reason !== "breakpoint") throw httpError("resume only valid for breakpoint pause", 400);
  // leave resume_edge_kind unset; executor skips re-entry for Breakpoint node / enters dynamic target
} else if (kind === "approve" || kind === "reject") {
  if (reason !== "approval") throw httpError(...);
  cp.resume_edge_kind = kind === "approve" ? "success" : "failure";
} else if (kind === "input") {
  if (reason !== "input") throw httpError(...);
  const values = payload ?? {};
  cp.state = { ...cp.state, ...values };
  cp.pending_input = values;
} else throw httpError("invalid kind", 400);

insert run_signals { kind: mapKind(kind), payload_json, status: "consumed" }
append event signal_received
update runs: checkpoint_json=cp, status=queued, pause_reason=null (or keep until running)
await dispatchJob(runId)
```

Map DB `run_signals.kind`: `approve|reject` → `approval`; `input` → `input`; `resume` → `resume`.

State patch:

```ts
assert paused
let state = { ...checkpoint.state }
if (body.state) state = body.state
else if (body.patch) state = { ...state, ...body.patch }
else throw 400
checkpoint.state = state
update runs; append state_patched event; do NOT auto-resume
```

Cancel:

```ts
if (status === "paused") {
  update status=cancelled, finishedAt=now, pause_reason=null
  return { id, status: "cancelled" }
}
// else existing queued|running → cancel_requested
```

- [ ] **Step 1: Write failing API + callback tests**

```ts
it("pause event sets run to paused and stores checkpoint", async () => {
  // create run (mock dispatch), POST internal event breakpoint_hit with checkpoint
  const res = await app.request(`/internal/runs/${runId}/events`, {
    method: "POST",
    headers: { "X-Executor-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "breakpoint_hit",
      node_id: "n_transform",
      payload: {
        checkpoint: {
          node_id: "n_transform",
          state: { flag: true },
          pause_kind: "breakpoint",
        },
      },
    }),
  });
  expect(res.status).toBe(201);
  const run = await app.request(`/runs/${runId}`, { headers: userHeaders });
  const body = await run.json();
  expect(body.status).toBe("paused");
  expect(body.pauseReason).toBe("breakpoint");
  expect(body.checkpoint.node_id).toBe("n_transform");
});

it("resume after breakpoint re-queues and dispatches", async () => {
  // given paused breakpoint run
  const sig = await app.request(`/runs/${runId}/signal`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ kind: "resume" }),
  });
  expect(sig.status).toBe(200);
  // status queued or running depending on mock dispatch
});

it("rejects approve when pause_reason is breakpoint", async () => {
  const sig = await app.request(`/runs/${runId}/signal`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ kind: "approve" }),
  });
  expect(sig.status).toBe(400);
});

it("PATCH state while paused emits state_patched", async () => {
  const res = await app.request(`/runs/${runId}/state`, {
    method: "PATCH",
    headers: userHeaders,
    body: JSON.stringify({ patch: { debug: 1 } }),
  });
  expect(res.status).toBe(200);
  const ev = await app.request(`/runs/${runId}/events?after_seq=0`, {
    headers: userHeaders,
  });
  const types = (await ev.json()).events.map((e: { eventType: string }) => e.eventType);
  expect(types).toContain("state_patched");
});

it("cancel while paused → cancelled", async () => {
  const res = await app.request(`/runs/${runId}/cancel`, {
    method: "POST",
    headers: userHeaders,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("cancelled");
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @awo/control-plane exec vitest run tests/runs.test.ts tests/executor-callback.test.ts
```

- [ ] **Step 3: Implement service methods, routes, internal pause handling, executor-client job fields**

Wire routes in `runs.ts` (same error mapping pattern as existing handlers). Export new functions from `run-service.ts`: `signalRun`, `patchRunState`, `putBreakpoints`, `getBreakpoints`; extend `getRun`, `cancelRun`.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src apps/control-plane/tests
git commit -m "feat(control-plane): pause handling, signal, state patch, breakpoints APIs"
```

---

### Task 4: Python executor — breakpoints, Breakpoint / HumanApproval / Input, checkpoint resume

**Files:**
- Modify: `apps/executor-py/src/awo_executor/engine.py`, `apps/executor-py/src/awo_executor/nodes.py`
- Test: `apps/executor-py/tests/test_engine.py`, `apps/executor-py/tests/test_nodes.py`
- Optional fixture: `apps/executor-py/tests/fixtures/m3_approval_graph.json`

**Interfaces:**
- Consumes: JobPayload JSON with optional `checkpoint`, `breakpoints`
- Produces: ordered callbacks as M2, plus on pause:
  1. `breakpoint_hit` or `waiting_signal` event with `payload.checkpoint` (full Checkpoint object) and `node_id`
  2. Optional `post_status(run_id, "paused")` after the event (control plane event handler is authoritative)
  3. **Return from `run_job`** — do not post `succeeded`/`failed`

Extend `NodeResult`:

```python
@dataclass
class NodeResult:
    ok: bool
    state: dict[str, Any]
    output: dict[str, Any] = field(default_factory=dict)
    next_node_id: str | None = None
    terminal: bool = False
    pause: bool = False
    pause_kind: str | None = None  # breakpoint | approval | input
    waiting_schema: dict[str, Any] | None = None
    emit_payload: dict[str, Any] | None = None
    error: str | None = None
    error_code: str | None = None
```

Node handlers:
- `execute_breakpoint(config, state)` → `ok=True`, `pause=True`, `pause_kind="breakpoint"`, state unchanged
- `execute_human_approval(config, state)` → `pause=True`, `pause_kind="approval"`
- `execute_input(config, state)` → `pause=True`, `pause_kind="input"`, `waiting_schema=config.get("schema")`

Engine loop changes:

1. **Start from checkpoint** when present:
   - `state = copy.deepcopy(checkpoint["state"])`
   - `current_id = checkpoint["node_id"]`
   - `resuming = True`
   - Still post `running` + `run_started` (or a `log` that this is a resume — keep `run_started` for simplicity; timeline may show multiple — acceptable for M3; alternatively skip duplicate `run_started` if events already exist — **prefer:** always `post_status(running)`; emit `log` `{message:"resume", checkpoint_node}` instead of second `run_started`)
2. **Before enter** (when not handling resume skip):
   - If `current_id in breakpoints` and not (`resuming` and checkpoint was dynamic pause on this id with signal resume already applied): emit `breakpoint_hit`, build checkpoint, exit
   - On **first** job hit: pause before enter (no `node_started` yet)
   - On **resume** after dynamic BP: `resuming` clears the before-enter check for that `node_id` once, then enters normally
3. **Breakpoint node resume:** if `resuming` and `pause_kind==breakpoint` and node type is `Breakpoint`: do **not** call execute again; emit nothing for re-entry; set `current_id = pick_default_next(out_edges)`; clear `resuming`; continue
4. **Approval resume:** if `resuming` and `pause_kind==approval`: take edge `resume_edge_kind` (`failure` fallback to `default` if missing); clear resuming; no `node_started`/`finished` for approval again
5. **Input resume:** if `resuming` and `pause_kind==input`: merge `pending_input` or already-merged state; take default/success out; clear resuming
6. After normal execute, if `result.pause`: emit appropriate event + checkpoint (`node_id`, `state=result.state`, `pause_kind`), then return

Checkpoint builder helper in engine:

```python
def _checkpoint(node_id: str, state: dict, pause_kind: str, **extra) -> dict:
    cp = {"node_id": node_id, "state": copy.deepcopy(state), "pause_kind": pause_kind}
    cp.update(extra)
    return cp
```

`waiting_signal` payload:

```python
{
  "kind": "approval" | "input",  # mirror pause_kind mapping
  "schema": result.waiting_schema,  # optional
  "checkpoint": cp,
}
```

`breakpoint_hit` payload:

```python
{"checkpoint": cp, "state_snapshot": cp["state"]}
```

- [ ] **Step 1: Write failing pytest**

```python
def test_dynamic_breakpoint_pauses_before_enter(mock_callbacks):
    job = {
        "run_id": "r1",
        "flow_version_id": "fv",
        "graph": MINIMAL_TRANSFORM_GRAPH,  # start → transform → end
        "input": {"x": 1},
        "breakpoints": ["n_transform"],
        "callback_base_url": "http://example",
        "token": "t",
    }
    run_job(job, mock_callbacks)
    types = [e["event_type"] for e in mock_callbacks.events]
    assert "breakpoint_hit" in types
    assert mock_callbacks.final_status == "paused" or any(
        e["event_type"] == "breakpoint_hit" for e in mock_callbacks.events
    )
    # transform must NOT have node_finished
    finished_nodes = [
        e["node_id"]
        for e in mock_callbacks.events
        if e["event_type"] == "node_finished"
    ]
    assert "n_transform" not in finished_nodes


def test_resume_after_dynamic_breakpoint_enters_node(mock_callbacks):
    job = {
        **BASE,
        "breakpoints": [],
        "checkpoint": {
            "node_id": "n_transform",
            "state": {"x": 1},
            "pause_kind": "breakpoint",
        },
        "input": {"x": 1},
    }
    run_job(job, mock_callbacks)
    assert mock_callbacks.final_status == "succeeded"


def test_human_approval_reject_takes_failure_edge(mock_callbacks):
    job = {
        **APPROVAL_GRAPH_JOB,
        "checkpoint": {
            "node_id": "n_approve",
            "state": {"ok": True},
            "pause_kind": "approval",
            "resume_edge_kind": "failure",
        },
    }
    run_job(job, mock_callbacks)
    # lands on failure End; succeeded with expected output marker
    assert mock_callbacks.final_status == "succeeded"
    assert mock_callbacks.output.get("path") == "rejected"  # set by Transform on failure path
```

Also unit-test `execute_breakpoint` / `execute_human_approval` / `execute_input` return `pause=True`.

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/executor-py && python -m pytest tests/test_engine.py tests/test_nodes.py -v
```

- [ ] **Step 3: Implement nodes + engine resume/pause paths; keep M2 graphs green**

Re-run full executor suite to ensure Start→Transform→Branch→Emit→End still passes.

- [ ] **Step 4: Run pytest — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/executor-py
git commit -m "feat(executor-py): checkpoint resume, breakpoints, approval and input nodes"
```

---

### Task 5: Integration test — pause → patch/signal → resume (+ cancel)

**Files:**
- Create: `apps/control-plane/tests/m3-integration.test.ts`
- Modify: root `package.json` — add `"test:m3"` script (mirror `test:m2`)

**Interfaces:**
- Consumes: live Postgres, Hono app, spawned uvicorn executor (copy spawn helpers from `m3-integration` ← clone patterns in `tests/m2-integration.test.ts`)
- Produces automated coverage of acceptance §7.1–7.5

`package.json` script:

```json
"test:m3": "DATABASE_URL=${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo} EXECUTOR_TOKEN=${EXECUTOR_TOKEN:-test-executor-token-m3} pnpm --filter @awo/control-plane exec vitest run tests/m3-integration.test.ts"
```

Graphs to publish inside the test:

1. **Breakpoint graph:** Start → Transform(`n_transform`) → Emit → End  
2. **Approval graph:** Start → HumanApproval(`n_approve`) → (success) Transform(set `path=approved`) → End; (failure) Transform(set `path=rejected`) → End  
3. **Input graph:** Start → Input(`n_input`, schema `{name:string}`) → Emit → End

Required cases (can be separate `it` blocks sharing `beforeAll` servers):

```ts
it("dynamic breakpoint → patch state → resume → succeeded", async () => {
  // publish breakpoint graph; PUT breakpoints { node_ids: ["n_transform"] } after create
  // OR create run then PUT breakpoints then... breakpoints must be set BEFORE first dispatch.
  // So: create flow, publish, createTestRun, but breakpoints on create need to exist first.
  // Approach: createTestRun, immediately the job may race — better:
  // 1) create run with mocked dispatch disabled OR
  // 2) PUT breakpoints endpoint before dispatch by adding optional breakpoints on test-run body — OUT OF SCOPE.
  // Locked approach for M3: 
  //   a) POST test-runs (job may start)
  //   b) For deterministic test: call putBreakpoints THEN use a graph that has a Breakpoint *node*
  //      so no race; additionally test dynamic BP by putting breakpoints while paused is useless.
  // Deterministic dynamic BP: extend createTestRun only in test via direct DB insert of run_breakpoints
  // BEFORE dispatchJob — integration test helper:
  //   insert run row + breakpoints, then dispatchJob(runId) manually.
});
```

**Deterministic helper (required in this task):** export or duplicate a test-only path:

1. Insert published flow as M2 test does  
2. `createTestRun` normally for Breakpoint-**node** and HumanApproval/Input graphs (no race)  
3. For **dynamic** breakpoints: after inserting run in a small service helper used by tests, OR: `PUT /runs/:id/breakpoints` is documented as applying to **next** dispatch — for first dispatch, integration test inserts into `run_breakpoints` inside the test via drizzle **before** calling `dispatchJob`, using a two-phase create:
   - Add optional body field **only if already exists** — do **not** add API field in M3  
   - Instead: in integration test, use `db.insert(runBreakpoints)` then `dispatchJob` after manually inserting a `queued` run (copy `createTestRun` internals)  
   - Simpler acceptable approach: **primary dynamic BP test in Python unit tests (Task 4)**; integration test uses a **`Breakpoint` node** in the graph for pause→patch→resume, and separately tests HumanApproval/Input via signals. Still call `PUT /runs/:id/breakpoints` while paused and assert GET; prove dynamic BP on a **second** segment by setting breakpoints while paused on a successor then resume (optional).  

**Minimum integration assertions (must all pass):**

1. Graph with `Breakpoint` node: run → `paused` / `pauseReason=breakpoint` → `PATCH state` `{patch:{debug:true}}` → events include `state_patched` → `signal resume` → `succeeded`; events include `breakpoint_hit`, `signal_received`  
2. HumanApproval: Approve → output/state shows success path; new run Reject → failure path  
3. Input: `signal input` with `{name:"Ada"}` → later Emit/state contains `name`  
4. Cancel while paused → `cancelled`; no `node_finished` after cancel timestamp  

Poll helper:

```ts
async function waitForStatus(runId: string, want: string | string[], timeoutMs = 15000) {
  const set = new Set(Array.isArray(want) ? want : [want]);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(`/runs/${runId}`, { headers: userHeaders });
    const body = await res.json();
    if (set.has(body.status)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${[...set]}`);
}
```

- [ ] **Step 1: Write failing integration test file**

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm test:m3
```

- [ ] **Step 3: Fix wiring / races / tokens (same ports pattern as M2)**

Also re-run `pnpm test:m2` to ensure no regression.

- [ ] **Step 4: Run `pnpm test:m3` and `pnpm test:m2` — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/tests/m3-integration.test.ts package.json
git commit -m "test: M3 pause signal resume integration"
```

---

### Task 6: Web — SignalPanel, state editor, breakpoints, timeline, poll, sample

**Files:**
- Create: `apps/web/src/run/SignalPanel.tsx`, `apps/web/src/run/StateEditor.tsx`, `apps/web/src/sample-m3-graph.ts`
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/runs.test.ts`, `apps/web/src/run/useRunPoll.ts`, `apps/web/src/run/useRunPoll.test.ts`, `apps/web/src/run/RunTimeline.tsx`, `apps/web/src/run/TestRunPanel.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles/run.css`, `apps/web/src/canvas/nodes/BaseNode.tsx` (Breakpoint color if missing)

**Interfaces:**
- Consumes: Task 3 HTTP APIs
- Produces UI:
  - `ACTIVE_RUN_STATUSES` includes `"paused"` so polling continues
  - Pause banner: reason + node id from `run.pauseReason` / `run.checkpoint?.node_id`
  - `SignalPanel`: show Approve/Reject if `pauseReason==="approval"`; Input form if `input`; Resume if `breakpoint`
  - `StateEditor`: textarea JSON, Save → `PATCH /runs/:id/state` with `{ state: parsed }` (full replace from editor)
  - Breakpoint toggles: when a run is selected (or last run), right-click / button on selected canvas node calls `putBreakpoints` with toggled set; highlight nodes whose ids are in active breakpoints (CSS class `awo-node--breakpoint`)
  - Timeline labels for `breakpoint_hit`, `waiting_signal`, `signal_received`, `state_patched`
  - Sample: `SAMPLE_M3_GRAPH` — Start → Transform → Breakpoint → HumanApproval → (success Emit → End) / (failure End); load button in App
  - `RunStatus` type in client includes `paused`; `RunDetail` adds `pauseReason`, `checkpoint`

Client additions:

```ts
signalRun(runId: string, body: { kind: "approve"|"reject"|"input"|"resume"; payload?: unknown })
patchRunState(runId: string, body: { state?: object; patch?: object })
getBreakpoints(runId: string) // → { node_ids: string[] }
putBreakpoints(runId: string, nodeIds: string[])
```

`useRunPoll` change:

```ts
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "paused",
  "cancel_requested",
]);
```

Update `useRunPoll.test.ts` so `paused` keeps polling `true`.

- [ ] **Step 1: Write failing client + poll tests**

```ts
it("createApiClient.signalRun posts kind resume", async () => {
  const calls: string[] = [];
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ id: "run_1", status: "queued" }), {
        status: 200,
      });
    },
  });
  await client.signalRun("run_1", { kind: "resume" });
  expect(calls[0]).toContain("POST");
  expect(calls[0]).toContain("/runs/run_1/signal");
});

it("nextPollingState stays active for paused", () => {
  expect(nextPollingState({ fetchOk: true, status: "paused" })).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @awo/web test
```

- [ ] **Step 3: Implement client, poll, SignalPanel, StateEditor, timeline, sample, App wiring, CSS**

Manual smoke checklist (document in commit message / README later):

```bash
pnpm db:up
pnpm --filter @awo/control-plane db:migrate && pnpm --filter @awo/control-plane db:seed
EXECUTOR_TOKEN=dev EXECUTOR_URL=http://127.0.0.1:8790 CALLBACK_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @awo/control-plane dev
cd apps/executor-py && EXECUTOR_TOKEN=dev uvicorn awo_executor.main:app --port 8790
pnpm --filter @awo/web dev
```

1. Load M3 sample → Save → Publish → 试运行  
2. Hit Breakpoint → banner + Resume; edit state; continue  
3. Hit HumanApproval → Approve / Reject  
4. Timeline shows new event types; poll does not stop while paused  

- [ ] **Step 4: Run unit tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): signal panel, state editor, breakpoints, M3 sample"
```

---

### Task 7: Docs — OpenAPI, README, design status, parent status

**Files:**
- Modify: `docs/run-protocol-openapi.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md` (Status)
- Modify: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (Status line)

**Interfaces:**
- Consumes: implemented routes from Tasks 3–6
- Produces: documented M3 surface + resume rules

- [ ] **Step 1: Update M3 design Status**

```
- Status: approved; plan in `docs/superpowers/plans/2026-10-22-m3-breakpoint-signal-human-approval.md`
```

Update parent design Status to also list the M3 plan path (keep M1/M2/M3 design references).

- [ ] **Step 2: Extend OpenAPI sketch**

Document:
- `paused` in RunStatus  
- New event types + checkpoint-in-payload on pause events  
- `JobPayload.checkpoint` / `breakpoints`  
- `POST /runs/{id}/signal`, `PATCH /runs/{id}/state`, `PUT|GET /runs/{id}/breakpoints`  
- Cancel from `paused` → `cancelled`  
- Resume rules paragraph (dynamic BP before-enter; Breakpoint node enter-then-pause, resume skips re-entry; approval edge kinds)

- [ ] **Step 3: README M3 section**

Acceptance checklist matching spec §7; note `pnpm test:m3`; how to run sample.

- [ ] **Step 4: Commit**

```bash
git add docs README.md
git commit -m "docs: M3 protocol sketch, README acceptance, design status"
```

---

## Spec coverage (self-review)

| Spec item | Plan task |
|---|---|
| Goal: breakpoint pause → patch → resume | Tasks 3–6 (integration Task 5) |
| HumanApproval / Input signals | Tasks 3–4, 5, 6 |
| Checkpoint resume (stateless jobs) | Tasks 1, 3, 4 |
| RunStatus `paused` | Task 1, 3, 6 |
| Events `breakpoint_hit`, `waiting_signal`, `signal_received`, `state_patched` | Tasks 1, 3, 4, 6 |
| Checkpoint + JobPayload fields | Tasks 1, 3, 4 |
| User APIs signal / state / breakpoints / cancel from paused | Task 3 |
| Invalid signal → 400 | Task 3 |
| Pause via event payload (no `/pause`) | Task 3 |
| `runs.checkpoint_json` / `pause_reason` | Task 2 |
| `run_breakpoints` / `run_signals` | Task 2 |
| Migration `0003_m3_pause_signal` | Task 2 |
| Dynamic BP before-enter | Task 4 (+ unit); Task 5 Breakpoint node path |
| Breakpoint node enter-then-pause; resume skips re-entry | Task 4 |
| Approve/reject edges; Input merge | Tasks 3–5 |
| Web SignalPanel / state editor / BP toggles / poll on paused / sample | Task 6 |
| Docs OpenAPI + README; parent status | Task 7 |
| No step API / no WS / published-only / no M4–M5 | Global Constraints |
| Seq monotonic server-side | Unchanged (Task 3 events) |
| Integration without hanging worker | Task 5 |

## Placeholder / consistency check

- Paths: `apps/control-plane` throughout (never `apps/api`)
- IDs: `u_dev`, `ws_demo`, `p_demo` unchanged
- Ports: control-plane `8787`, web `5173`, executor `8790`
- Env: `EXECUTOR_URL`, `EXECUTOR_TOKEN`, `CALLBACK_BASE_URL`, `DATABASE_URL`
- Pause kinds: `breakpoint | approval | input` only
- Signal API kinds: `approve | reject | input | resume`
- DB signal kinds: `approval | input | resume`
- No TBD/TODO steps; dynamic-BP race for first dispatch resolved via Breakpoint-node integration + Python unit for before-enter
- `test:m2` must remain green after M3

## Stretch (explicitly optional — skip unless ahead of schedule)

- Optional `breakpoints` on `POST .../test-runs` body to avoid DB helper for dynamic BP integration
- Canvas glow for paused current node
- Skip duplicate `run_started` on resume
- SSE timeline push

---

## Execution handoff

After this plan is approved for execution, choose:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute in this session with checkpoints  

Start at Task 1. Do not implement M4+ items from this plan.
