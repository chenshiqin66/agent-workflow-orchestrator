# Run protocol — OpenAPI sketch (M2)

Sketch of HTTP surfaces added in M2. Not a machine-generated OpenAPI file; shapes match `@awo/run-protocol` and the live Hono/FastAPI handlers.

**Ports (local):** control-plane `8787`, executor `8790`, web `5173`.

**Auth:**

| Caller | Header | Secret |
|---|---|---|
| Web / user APIs | `X-User-Id` (stub) | seeded `u_dev` |
| Control plane → executor | `X-Executor-Token` | `EXECUTOR_TOKEN` |
| Executor → control plane callbacks | `X-Executor-Token` | same `EXECUTOR_TOKEN` |

Shared types live in `packages/run-protocol` (`RunStatus`, `RunEventType`, `JobPayload`, `CallbackEventBody`).

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

Only published versions are runnable in M2 (draft dry-run deferred).

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
  "status": "running",
  "inputJson": {},
  "outputJson": null,
  "errorMessage": null,
  "startedAt": "…",
  "finishedAt": null,
  "costTokens": null,
  "createdBy": "u_dev",
  "createdAt": "…"
}
```

`status` ∈ `queued | running | succeeded | failed | cancelled | cancel_requested`.

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

`eventType` ∈ `run_started | run_finished | node_started | node_finished | node_failed | emit | log`.  
Server assigns monotonic `seq` per `run_id` starting at `1` (client optional `seq` is ignored).

### `POST /runs/{runId}/cancel`

Marks run `cancel_requested` when status is `queued` or `running`. Mid-flight cancel in the executor is **not** honored in M2 (stretch).

**Response `200`:** `{ "id", "status": "cancel_requested" }`.

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

**Response `200`:** `{ "id", "status" }`.

Sets `startedAt` on first `running`; sets `finishedAt` on terminal statuses (`succeeded | failed | cancelled`).

---

## Executor — job intake

Base: `http://127.0.0.1:8790`. Header: `X-Executor-Token: <EXECUTOR_TOKEN>` (or `Authorization: Bearer …`).

### `GET /health`

`{ "ok": true }`

### `POST /v1/jobs`

Accepts `JobPayload`, returns `202` immediately, runs the graph on a background thread, then POSTs status/events to `callback_base_url`.

**Request (`JobPayload`)**

```json
{
  "run_id": "run_…",
  "flow_version_id": "fv_…",
  "graph": { "nodes": [], "edges": [] },
  "input": {},
  "callback_base_url": "http://127.0.0.1:8787",
  "token": "<same as EXECUTOR_TOKEN>"
}
```

**Responses**

| Code | Meaning |
|---|---|
| `202` | `{ "accepted": true, "run_id" }` — execution started async |
| `400` | missing fields / invalid JSON |
| `401` | bad header token or job `token` mismatch |
| `500` | `EXECUTOR_TOKEN` unset on executor |

M2 node subset for happy path: `Start`, `End`, `Transform`, `Branch`, `Emit` (optional `LLM` stub). No HTTP/HumanApproval required for the demo graph.

---

## Env vars (local)

| Variable | Process | Notes |
|---|---|---|
| `DATABASE_URL` | control-plane | e.g. `postgres://awo:awo@localhost:5432/awo` |
| `EXECUTOR_URL` | control-plane | default `http://127.0.0.1:8790` |
| `EXECUTOR_TOKEN` | control-plane **and** executor | required shared secret; no default for dispatch |
| `CALLBACK_BASE_URL` | control-plane (embedded in job) | default `http://127.0.0.1:8787` |
| `X-User-Id` | HTTP header (web) | stub auth `u_dev` |

See also `apps/executor-py/README.md` and root `README.md` M2 section.
