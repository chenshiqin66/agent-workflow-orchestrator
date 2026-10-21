# Design Spec: M3 — Breakpoint / Signal / Human Approval

- Date: 2026-10-22
- Status: draft for user review
- Parent: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (§11 M3)
- Depends on: M1 (graph canvas + publish) + M2 (Python executor + test run + timeline)
- Architecture choice: **checkpoint resume** (stateless executor jobs)

## 1. Goal

Ship the debug/approval loop on top of M2:

1. Hit a **breakpoint** (or `Breakpoint` node), pause the run, optionally patch state, resume
2. Hit **`HumanApproval`** / **`Input`**, pause for a user **signal**, then continue on the correct edge
3. Persist pause reason + checkpoint so executor restarts do not lose in-flight paused runs

Non-goals (explicitly out of M3):

- Explicit single-step API (`step`); temporary next-node breakpoint is enough
- WebSocket push (keep HTTP poll)
- Real multi-approver routing / SLA / email notify
- M4 roles / publish gate / asset registry
- Mid-flight cancel inside a running executor process beyond M2 `cancel_requested` polling semantics
- Draft dry-run (still published-only)

## 2. Approach (checkpoint resume)

When the executor would wait (breakpoint hit, HumanApproval, Input):

1. Emit a pause event (`breakpoint_hit` or `waiting_signal`) via existing callback
2. Persist a **checkpoint** `{ node_id, state, pause_kind, pending_ports? }` on the control plane
3. Set run status to `paused` and **end the current job** (no long-lived blocked worker)

When the user signals or resumes:

1. Control plane validates run is `paused`, records `run_signals` / state patch
2. Re-dispatch a new job with the same graph + `checkpoint` (+ updated `breakpoints` / signal outcome)
3. Executor continues from the checkpoint until finish or next pause

Rationale: language-agnostic executors stay swap-friendly; pause survives executor restart; fits M2 HTTP push + callback transport.

Rejected alternatives:

- In-process suspend/wait: lost on restart, holds workers
- Per-node control-plane scheduler: rewrites M2 execution model

## 3. Protocol extensions (`@awo/run-protocol`)

### 3.1 RunStatus

Add `paused` to existing:

`queued | running | paused | succeeded | failed | cancelled | cancel_requested`

### 3.2 RunEventType

Add:

- `breakpoint_hit` — payload: `{ node_id, state_snapshot? }`
- `waiting_signal` — payload: `{ node_id, kind: "approval" | "input", schema? }`
- `signal_received` — payload: `{ signal_id, kind, outcome? }`
- `state_patched` — payload: `{ patch | full_state }`

### 3.3 Checkpoint + JobPayload

```ts
Checkpoint = {
  node_id: string;
  state: Record<string, unknown>;
  pause_kind: "breakpoint" | "approval" | "input";
  /** After approval/reject: which outgoing edge kind to take on resume */
  resume_edge_kind?: "success" | "failure" | "default";
  /** After input: values already merged or to merge on resume */
  pending_input?: Record<string, unknown>;
}

JobPayload += {
  checkpoint?: Checkpoint;
  breakpoints?: string[]; // node ids to pause BEFORE entering
}
```

### 3.4 User APIs (control plane)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/runs/{runId}/signal` | Body: `{ kind: "approve" \| "reject" \| "input" \| "resume", payload?: object }` — only when `paused` |
| `PATCH` | `/runs/{runId}/state` | Body: `{ state: object }` full replace or `{ patch: object }` shallow merge — only when `paused`; emit `state_patched` |
| `PUT` | `/runs/{runId}/breakpoints` | Body: `{ node_ids: string[] }` upsert active breakpoints for this run |
| `GET` | `/runs/{runId}/breakpoints` | List active breakpoints |
| existing | `POST /runs/{runId}/cancel` | Allowed from `paused` → `cancelled` (no re-dispatch) |

Signal semantics:

- `approve` → set `resume_edge_kind=success`, re-dispatch
- `reject` → `resume_edge_kind=failure` (fallback `default` if no failure edge), re-dispatch
- `input` → merge `payload` into checkpoint state, re-dispatch
- `resume` → after breakpoint (and optional state patch), re-dispatch continuing past the paused node

Invalid signal for current `pause_reason` → `400`.

### 3.5 Internal callbacks

Reuse M2 event callback. Pause events must include enough for control plane to store `checkpoint_json`. Optional dedicated `POST /internal/runs/{id}/pause` is **not** required if event payload carries checkpoint; prefer one callback path.

On pause event: control plane sets `status=paused`, stores checkpoint + pause_reason, does not leave status `running`.

## 4. Data model

Extend `runs`:

- `checkpoint_json` nullable
- `pause_reason` nullable enum/text: `breakpoint | approval | input`

New tables (as in parent E-R):

| Table | Fields |
|---|---|
| `run_breakpoints` | `id`, `run_id`, `node_id`, `active` (unique run_id+node_id) |
| `run_signals` | `id`, `run_id`, `kind` (`approval`/`input`/`resume`), `payload_json`, `status` (`pending`/`consumed`/`rejected`), `created_at` |

Migration: `0003_m3_pause_signal` (name exact in plan).

## 5. Executor (Python)

Node handlers for M3:

- **`Breakpoint`**: always pause with `pause_kind=breakpoint` before/as the node (treat as no-op transform that forces pause)
- **Dynamic breakpoints**: before entering any node whose id is in `job.breakpoints`, emit `breakpoint_hit` and exit with checkpoint at that node
- **`HumanApproval`**: emit `waiting_signal` kind=approval; exit paused; on resume with approve/reject, take success/failure edge without re-running approval side effects
- **`Input`**: emit `waiting_signal` kind=input + optional JSON schema from node config; on resume merge input into state then continue

Resume rules:

- If `checkpoint.pause_kind == breakpoint` and signal is `resume`: continue **after** the paused node (or enter it once if pause was before-enter — pick **before-enter** consistently for dynamic breakpoints; `Breakpoint` node counts as entered then paused, resume skips re-entry)
- Document the chosen rule in OpenAPI sketch and tests

Keep AST-safe Branch; no real LLM. Cancel: if job sees cancel via existing mechanism mid-run, finish as today; paused runs cancel only on control plane.

## 6. Web UI

- Timeline renders new event types
- When `status === paused`, show pause banner (reason + node id) and **SignalPanel**: Approve / Reject / Input form / Resume
- State editor (JSON) enabled only while paused; calls `PATCH …/state`
- Breakpoint toggles on canvas nodes; sync `PUT …/breakpoints` for the active run (and optionally stash desired breakpoints to send on next test-run create — M3 minimum: active run only)
- Polling: do **not** stop on `paused`; stop only on terminal statuses (same as M2 error-stop fix)
- Sample graph: include `HumanApproval` + at least one breakpoint target

## 7. Acceptance

1. Test run hits dynamic breakpoint → `paused` → patch state → `resume` → run succeeds; timeline shows `breakpoint_hit`, `state_patched`, `signal_received`
2. Graph with `HumanApproval`: Approve takes success path; Reject takes failure path
3. `Input` node: submitted values appear in later node state / emit
4. Cancel while `paused` → `cancelled`, no further events after cancel
5. Integration test covers pause → signal → resume without hanging worker
6. Docs: update `docs/run-protocol-openapi.md` + README M3 section; parent design status notes M3 plan when written

## 8. Implementation notes for planning

- Extend `@awo/run-protocol` first (types + tests), then DB/API, then executor, then web, then docs — same SDD style as M2
- Single-step: out of scope; implement via setting breakpoint on successor if needed later
- Seq assignment remains server-side monotonic (M2)

## 9. Open items resolved in this chat

- Scope: full M3 (breakpoint + signal + HumanApproval), not a slice
- Resume model: checkpoint re-dispatch (not in-process wait, not per-node CP scheduler)
- No per-section UI micro-approval; UI as §6
- Explicit step API: deferred

## 10. Approval

Discussed 2026-10-22 in chat. Awaiting user review of this written spec before `writing-plans`.
