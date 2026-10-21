# Run protocol — OpenAPI sketch (M2 + M3)

Sketch of HTTP surfaces added in M2/M3. Not a machine-generated OpenAPI file; shapes match `@awo/run-protocol` and the live Hono/FastAPI handlers.

**Ports (local):** control-plane `8787`, executor `8790`, web `5173`.

**Auth:**

| Caller | Header | Secret |
|---|---|---|
| Web / user APIs | `X-User-Id` (stub) | seeded `u_dev` |
| Control plane → executor | `X-Executor-Token` | `EXECUTOR_TOKEN` |
| Executor → control plane callbacks | `X-Executor-Token` | same `EXECUTOR_TOKEN` |

Shared types live in `packages/run-protocol` (`RunStatus`, `RunEventType`, `Checkpoint`, `JobPayload`, `CallbackEventBody`, `SignalKind`).

---

## Control plane — user-facing run APIs

Base: `http://127.0.0.1:8787`. Header: `X-User-Id: u_dev`.

### `POST /flows/{flowId}/test-runs`

Create a test run against the flow’s **published** version and dispatch a job to the executor.

**Request**

```json
{ "input": { "amount": 42 } }
```

`input` must be a JSON object (required).

**Responses**

| Code | Body |
|---|---|
| `201` | `{ "id", "status", "flowVersionId" }` — `status` is usually `"queued"`; may already be `"failed"` if dispatch failed |
| `400` | no published version, bad body, etc. |
| `404` | flow not in workspace |

Only published versions are runnable (draft dry-run deferred). Active breakpoints for a new run start empty; set them with `PUT /runs/{id}/breakpoints` after create (or before resume).

### `GET /flows/{flowId}/runs`

List recent runs for a flow (newest first, default limit 20).

**Response `200`:** array of `{ id, flowVersionId, trigger, status, createdAt, startedAt, finishedAt }`.

### `GET /runs/{runId}`

**Response `200`:**

```json
{
  "id": "run_…",
  "flowVersionId": "fv_…",
  "trigger": "test",
  "status": "paused",
  "inputJson": {},
  "outputJson": null,
  "errorMessage": null,
  "startedAt": "…",
  "finishedAt": null,
  "costTokens": null,
  "createdBy": "u_dev",
  "createdAt": "…",
  "pauseReason": "breakpoint",
  "checkpoint": {
    "node_id": "n_bp",
    "state": { "x": 1 },
    "pause_kind": "breakpoint"
  }
}
```

`status` ∈ `queued | running | paused | succeeded | failed | cancelled | cancel_requested`.

M3 fields (nullable when not paused):

- `pauseReason` ∈ `breakpoint | approval | input | null`
- `checkpoint` — see Checkpoint below; `null` when not paused / not stored

### `GET /runs/{runId}/events?after_seq=0`

Poll timeline. `after_seq` defaults to `0`; returns events with `seq > after_seq`, ordered ascending.

**Response `200`:**

```json
{
  "events": [
    {
      "id": "re_…",
      "runId": "run_…",
      "seq": 1,
      "nodeId": "n_start",
      "eventType": "run_started",
      "payload": {},
      "ts": "…"
    }
  ]
}
```

`eventType` ∈

`run_started | run_finished | node_started | node_finished | node_failed | emit | log | breakpoint_hit | waiting_signal | signal_received | state_patched`

Server assigns monotonic `seq` per `run_id` starting at `1` (client optional `seq` is ignored).

**Pause events (M3):** `breakpoint_hit` and `waiting_signal` must carry a valid `Checkpoint` under `payload.checkpoint`. The control plane stores it on `runs.checkpoint_json`, sets `pause_reason` from `checkpoint.pause_kind`, and flips status to `paused`. There is **no** separate `/internal/.../pause` endpoint.

Example pause payload:

```json
{
  "event_type": "breakpoint_hit",
  "node_id": "n_transform",
  "payload": {
    "checkpoint": {
      "node_id": "n_transform",
      "state": { "amount": 42 },
      "pause_kind": "breakpoint"
    }
  },
  "ts": "2026-10-22T04:00:00.000Z"
}
```

`waiting_signal` likewise includes `checkpoint` with `pause_kind` `approval` or `input` (optional `schema` / hint fields may appear alongside).

### `POST /runs/{runId}/cancel`

| Current status | Result |
|---|---|
| `queued` / `running` | → `cancel_requested` (M2; mid-flight cancel in executor is best-effort) |
| `paused` | → `cancelled` immediately, `finishedAt` set, **no** re-dispatch |

**Response `200`:** `{ "id", "status" }` (`cancel_requested` or `cancelled`).

### `POST /runs/{runId}/signal` (M3)

Only when `status === paused`. Body:

```json
{ "kind": "approve" | "reject" | "input" | "resume", "payload": {} }
```

| `kind` | Allowed when `pauseReason` | Effect |
|---|---|---|
| `resume` | `breakpoint` | Continue past the paused node; re-dispatch with checkpoint |
| `approve` | `approval` | Set `resume_edge_kind=success`; re-dispatch |
| `reject` | `approval` | Set `resume_edge_kind=failure` (executor falls back to `default` if no failure edge); re-dispatch |
| `input` | `input` | Merge `payload` into checkpoint state (`pending_input` / state); re-dispatch |

Invalid kind for current `pause_reason` → `400`. On success: appends `signal_received`, sets status `queued`, clears `pause_reason`, re-dispatches job with `JobPayload.checkpoint` (+ active `breakpoints`).

**Response `200`:** run summary including updated `status` / `checkpoint` (implementation returns the post-signal run view).

### `PATCH /runs/{runId}/state` (M3)

Only when `paused`. Body is **either** full replace or shallow merge (not both required; at least one):

```json
{ "state": { "amount": 99 } }
```

or

```json
{ "patch": { "amount": 99 } }
```

Updates `checkpoint.state`, appends `state_patched`. Does **not** auto-resume — caller must `POST …/signal` with `resume` / `approve` / etc.

**Response `200`:** `{ "id", "status", "pauseReason", "checkpoint", … }`.

### `PUT /runs/{runId}/breakpoints` (M3)

Replace the active dynamic breakpoint set for this run.

```json
{ "node_ids": ["n_transform", "n_end"] }
```

**Response `200`:** `{ "node_ids": ["n_transform", "n_end"] }` (active ids).

Included on every subsequent dispatch / re-dispatch as `JobPayload.breakpoints`.

### `GET /runs/{runId}/breakpoints` (M3)

**Response `200`:** `{ "node_ids": ["n_transform"] }`.

---

## Control plane — executor callbacks (internal)

Base: `http://127.0.0.1:8787`. Header: `X-Executor-Token: <EXECUTOR_TOKEN>`.  
Mounted under `/internal/*` with executor auth middleware.

### `POST /internal/runs/{runId}/events`

**Request (`CallbackEventBody`)**

```json
{
  "event_type": "node_finished",
  "node_id": "n_transform",
  "payload": { "ok": true },
  "ts": "2026-10-21T14:00:00.000Z"
}
```

`seq` optional (server assigns). `node_id` optional for run-level events.

For `breakpoint_hit` / `waiting_signal`, `payload.checkpoint` is **required** and must parse as `Checkpoint`; handler sets `paused` in the same transaction as the event insert.

**Response `201`:** inserted event including assigned `seq`.

### `POST /internal/runs/{runId}/status`

**Request**

```json
{
  "status": "succeeded",
  "output": { "result": 1 },
  "error_message": null
}
```

`status` may be `running | paused | succeeded | failed | cancelled` (executor normally ends the job after emitting a pause event; control plane already set `paused` from the event). Terminal statuses set `finishedAt`; `paused` does not.

**Response `200`:** `{ "id", "status" }`.

---

## Executor — job intake

Base: `http://127.0.0.1:8790`. Header: `X-Executor-Token: <EXECUTOR_TOKEN>` (or `Authorization: Bearer …`).

### `GET /health`

`{ "ok": true }`

### `POST /v1/jobs`

Accepts `JobPayload`, returns `202` immediately, runs the graph on a background thread, then POSTs status/events to `callback_base_url`. On pause, emits pause event (+ optional status) and **ends the job** (no blocked worker).

**Request (`JobPayload`)**

```json
{
  "run_id": "run_…",
  "flow_version_id": "fv_…",
  "graph": { "nodes": [], "edges": [] },
  "input": {},
  "callback_base_url": "http://127.0.0.1:8787",
  "token": "<same as EXECUTOR_TOKEN>",
  "checkpoint": {
    "node_id": "n_bp",
    "state": {},
    "pause_kind": "breakpoint",
    "resume_edge_kind": "success",
    "pending_input": {}
  },
  "breakpoints": ["n_transform"]
}
```

`checkpoint` and `breakpoints` are optional (M3). Cold start omits `checkpoint`; resume always includes the stored checkpoint.

**Checkpoint**

| Field | Required | Notes |
|---|---|---|
| `node_id` | yes | Paused at / before this node |
| `state` | yes | Executor working state |
| `pause_kind` | yes | `breakpoint \| approval \| input` |
| `resume_edge_kind` | no | Set by control plane on approve/reject |
| `pending_input` | no | Set/merged on input signal |

**Responses**

| Code | Meaning |
|---|---|
| `202` | `{ "accepted": true, "run_id" }` — execution started async |
| `400` | missing fields / invalid JSON |
| `401` | bad header token or job `token` mismatch |
| `500` | `EXECUTOR_TOKEN` unset on executor |

**M3 node subset:** `Breakpoint`, `HumanApproval`, `Input` (plus M2: `Start`, `End`, `Transform`, `Branch`, `Emit`, optional `LLM` stub).

### Resume rules (executor)

1. **Dynamic breakpoints** (`job.breakpoints`): pause **before entering** the listed `node_id` (no `node_started` for that enter). Checkpoint `node_id` is that node; `pause_kind=breakpoint`. On `resume`, **enter and run** the node (before-enter pause was not an execution).
2. **`Breakpoint` node**: treat as enter-then-pause (no-op transform that forces pause). On `resume`, **skip re-entry** and follow the outgoing edge.
3. **`HumanApproval`**: emit `waiting_signal` (`pause_kind=approval`), exit. On resume with `resume_edge_kind`, take that outgoing edge kind without re-running approval side effects (`approve` → `success`; `reject` → `failure`, else `default`).
4. **`Input`**: emit `waiting_signal` (`pause_kind=input`); on resume merge `pending_input` / signal payload into state, then continue on default/success out.
5. Jobs stay **stateless**: pause ends the process; resume is a new `POST /v1/jobs` with `checkpoint`.

---

## Env vars (local)

| Variable | Process | Notes |
|---|---|---|
| `DATABASE_URL` | control-plane | e.g. `postgres://awo:awo@localhost:5432/awo` |
| `EXECUTOR_URL` | control-plane | default `http://127.0.0.1:8790` |
| `EXECUTOR_TOKEN` | control-plane **and** executor | required shared secret; no default for dispatch |
| `CALLBACK_BASE_URL` | control-plane (embedded in job) | default `http://127.0.0.1:8787` |
| `X-User-Id` | HTTP header (web) | stub auth `u_dev` |

See also `apps/executor-py/README.md` and root `README.md` M2/M3 sections.
