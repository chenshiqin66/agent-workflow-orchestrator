# Design Spec: M5 — Subflow, Templates, Thin Metrics

- Date: 2026-10-22
- Status: approved; implemented on `feature/m5-subflow-templates-metrics`; plan in `docs/superpowers/plans/2026-10-22-m5-subflow-templates-metrics.md`
- Parent: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (§11 M5; §4.1 Subflow; §5 use cases 5–6; §6 Observability thin v1)
- Depends on: M1–M4 (graph publish, executor runs, pause/signal, roles + publish gate)
- Architecture choice: **control-plane expands Subflow into a flat JobPayload graph** before dispatch (executor stays Subflow-agnostic)

## 1. Goal

Close the v1 product arc with reuse and light ops visibility:

1. **Subflow** — a node that references a **published** `flow_version` and runs that graph inline (flattened) inside the parent run
2. **Templates** — snapshot a published graph as a workspace template; **clone** into a new draft flow (Builder path)
3. **Thin metrics** — success rate, latency, and token cost aggregates from the existing `runs` table by flow / version (no new observability stack)

Non-goals (explicitly out of M5 / YAGNI):

- CRDT multi-canvas real-time collaboration
- Full observability suite (traces, dashboards, alerts product, APM)
- WebSocket push (keep HTTP poll)
- Nested pause UX polish beyond “child nodes appear as prefixed ids on the timeline”
- Dynamic “always latest published” Subflow refs (M5 pins **`flow_version_id`** only)
- Template marketplace / cross-workspace sharing
- Changing M3 checkpoint semantics or M4 role ranks / gate bootstrap rules (only **add** a `subflow_refs` gate check)

## 2. Current baseline (what exists)

| Area | Today |
|---|---|
| Node catalog | No `Subflow` in `node_defs` / seed; executor returns `unsupported_node_type` |
| Graph schema | `type: string` freeform; no Subflow config validation beyond Zod record |
| Job dispatch | `run-service` sends parent `graph_json` as-is to executor |
| Publish gate | `required_config`, `successful_test_run`, `role_nodes` (M4) |
| Templates | None |
| Metrics | `runs.cost_tokens`, `started_at`, `finished_at`, `status` exist; no aggregate API |
| Web | Sample M2/M3 graphs; assets + roles UI; no template picker / metrics panel |

## 3. Subflow

### 3.1 Node contract

- **type**: `Subflow`
- **min_role**: `builder`
- **config** (required):

```json
{
  "flow_version_id": "fv_xxx"
}
```

Rules:

- `flow_version_id` must exist, `status = published`, and belong to a flow whose project is in the **same workspace** as the parent
- Self-reference (parent flow’s own published version) allowed only if expansion depth/cycle rules still pass (typically blocked by cycle detection when the child graph also points back)
- Optional future keys (`input_map`, `output_key`) are **out of M5** — child inherits full parent `state` at entry; after the inlined End, execution continues with that state (same as flattening the child’s nodes into the parent)

### 3.2 Expansion (control plane)

Before building `JobPayload.graph` (test or prod dispatch), call:

```ts
expandSubflows(graph, {
  resolvePublished: (flowVersionId) => Promise<FlowGraph | null>,
  maxDepth?: number // default 3
}): Promise<FlowGraph>
```

Algorithm:

1. Walk nodes; for each `type === "Subflow"`:
   - Resolve published graph `G_child` by `config.flow_version_id`
   - Recursively expand `G_child` (depth + 1); refuse if `depth > maxDepth` → error `subflow_depth_exceeded`
   - Refuse if `flow_version_id` already on the **expansion stack** → `subflow_cycle`
   - Prefix every child node/edge id and edge source/target with `${subflowNodeId}__`
   - Rewire: every incoming edge to the Subflow node retargets to the child’s **Start** node (exactly one Start required); every outgoing edge from the Subflow node is re-sourced from the child’s **End** node (exactly one End required)
   - Drop the Subflow placeholder node; splice in expanded child nodes/edges
2. Return flat graph with **no** remaining `Subflow` nodes

Rationale vs executor-native Subflow:

- Executor unchanged (M2/M3 path preserved)
- Timeline / breakpoints / HumanApproval inside children work with prefixed `node_id`s
- Published immutability: pinned `flow_version_id` matches M1 version model

Rejected alternatives:

- Long-lived nested jobs per Subflow (extra run rows, harder cancel)
- Always-latest `flow_id` ref (non-reproducible runs)

### 3.3 Publish gate addition

New check id: **`subflow_refs`**

- Every draft `Subflow` node must have non-empty `config.flow_version_id`
- Target version must be published + same workspace
- Dry-run expand with maxDepth=3 must succeed (surfaces cycle/depth/missing Start/End)

Failure shape unchanged: `400 { error: "publish_gate_failed", checks: [...] }`.

### 3.4 Roles

| Action | Min role |
|---|---|
| Place / edit Subflow node | builder+ (via existing draft save) |
| Publish graph containing Subflow | builder+ + gate |
| Test-run parent that expands Subflow | same as M4 (published builder+; draft developer+) |

## 4. Templates

### 4.1 Table

```
flow_templates(
  id text PK,
  workspace_id text not null,
  name text not null,
  description text not null default '',
  graph_json jsonb not null,          -- snapshot; rewrite graph.id on clone
  source_flow_version_id text,        -- optional audit pointer
  created_by text not null,
  created_at timestamptz not null default now()
)
unique (workspace_id, name)
```

Migration name exact: **`0005_m5_templates_metrics`** (templates table only; metrics need no DDL).

### 4.2 APIs

Base `/templates` (auth required).

| Method | Path | Min role | Behavior |
|---|---|---|---|
| `GET` | `/templates` | viewer+ | List workspace templates `{ id, name, description, createdAt, sourceFlowVersionId }` |
| `GET` | `/templates/:id` | viewer+ | Detail including `graph` |
| `POST` | `/templates` | developer+ | Body `{ name, description?, flow_version_id }` — copy **published** version’s `graph_json` into a new template |
| `DELETE` | `/templates/:id` | developer+ | Delete |
| `POST` | `/templates/:id/clone` | builder+ | Body `{ project_id, name }` — create new flow + draft version whose graph is a deep copy of template `graph_json` with new `graph.id` = new draft version id |

Clone uses the same insert pattern as `createFlow`, but seeds draft graph from the template instead of empty.

### 4.3 Seed

- One template `tpl_demo_ragish` (or similar) with Start → Transform → End sample graph
- Optional: also seed a tiny published “library” flow that demos can reference as Subflow target

## 5. Thin metrics

### 5.1 Source

Read-only SQL over `runs` ⋈ `flow_versions` ⋈ `flows` ⋈ `projects` scoped to caller workspace.

Terminal statuses for rate denominator: `succeeded | failed | cancelled` (exclude `queued|running|paused|cancel_requested` from completed set; optionally report `in_flight` count separately).

### 5.2 API

| Method | Path | Min role |
|---|---|---|
| `GET` | `/metrics/flows/:flowId` | viewer+ |
| `GET` | `/metrics/workspace` | viewer+ |

Query params (both):

- `from` / `to` — ISO timestamps (optional; default last 7 days in Asia/Shanghai wall interpretation stored as timestamptz)
- `trigger` — optional `test|prod|api` filter

Response shape (flow):

```json
{
  "flow_id": "flow_x",
  "from": "...",
  "to": "...",
  "totals": {
    "runs": 12,
    "succeeded": 10,
    "failed": 1,
    "cancelled": 1,
    "in_flight": 0,
    "success_rate": 0.8333,
    "avg_latency_ms": 1520,
    "sum_cost_tokens": 4200,
    "avg_cost_tokens": 350
  },
  "by_version": [
    {
      "flow_version_id": "fv_y",
      "version": 2,
      "status": "published",
      "runs": 5,
      "succeeded": 5,
      "failed": 0,
      "cancelled": 0,
      "success_rate": 1,
      "avg_latency_ms": 900,
      "sum_cost_tokens": 1000,
      "avg_cost_tokens": 200
    }
  ]
}
```

Latency: `extract(epoch from (finished_at - started_at)) * 1000` for rows with both timestamps set; ignore nulls in average.

Workspace endpoint: array of per-flow `totals` (no mandatory `by_version` to keep payload thin; include `flow_id`, `name`).

No Prometheus, no alert rules, no background rollup table in M5.

## 6. Web UI (thin)

- **Templates**: list + “从模板创建” → clone → load new flow in canvas
- **Subflow**: palette includes `Subflow`; node inspector field for `flow_version_id` (text input ok); sample graph demonstrating parent + published child
- **Metrics**: simple panel showing flow totals after selecting current flow (fetch `GET /metrics/flows/:id`)
- Keep poll-based run UI; no WS

## 7. Acceptance

1. Parent graph with `Subflow` → `flow_version_id` of published child expands; test-run succeeds; timeline shows prefixed child node ids.
2. Cycle / depth > 3 / missing Start|End → publish gate `subflow_refs` fails (and expand throws with stable error codes for runs).
3. Developer creates template from published version; builder clones to new draft flow with copied nodes.
4. Viewer can `GET` metrics; after several runs, `success_rate` / `avg_latency_ms` / `sum_cost_tokens` match SQL expectations.
5. `pnpm test:m5` green; `test:m2` / `test:m3` / `test:m4` still green.
6. No CRDT, no WS, no new metrics warehouse.

## 8. Approval

Approved for planning; implement via `docs/superpowers/plans/2026-10-22-m5-subflow-templates-metrics.md`.
