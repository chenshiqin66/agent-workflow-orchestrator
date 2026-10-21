# M5 Subflow + Templates + Thin Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Subflow nodes that expand published child graphs at dispatch time; workspace flow templates with clone-to-draft; thin success/latency/cost metrics aggregated from `runs`.

**Architecture:** Control plane owns Subflow expansion (`expandSubflows`) so the Python executor stays unchanged. Templates are a new `flow_templates` table plus CRUD/clone routes. Metrics are read-only SQL over existing run columns — no rollup tables, no WS, no CRDT.

**Tech Stack:** Existing M1–M4 stack — TypeScript, pnpm, Hono, Drizzle, PostgreSQL, Vite, React, XYFlow, Vitest, Zod. Paths use `apps/control-plane` (not `apps/api`). Executor: no Subflow-specific Python changes required.

**Spec:** `docs/superpowers/specs/2026-10-22-m5-subflow-templates-metrics-design.md`

## Global Constraints

- Product: 编排画布 + 运行时调试 — M5 ships **subflow + templates + thin metrics** only
- Auth: stub `X-User-Id` + `memberships.role`; executor callbacks `X-Executor-Token` unchanged
- Roles exact: `admin | developer | builder | viewer` with ranks 3/2/1/0 (reuse `roleAtLeast` / `requireRole`)
- Subflow pins **`flow_version_id`** (published only); no always-latest `flow_id` ref
- Expansion max depth **3**; cycle detection via expansion stack of version ids
- Flattened child node/edge ids: `` `${subflowNodeId}__${childId}` ``
- Migration name exact: `0005_m5_templates_metrics`
- Do not change M3 pause/signal/checkpoint behavior (prefixed ids must continue to work)
- Do not weaken M4 publish gate; only **add** check `subflow_refs`
- No CRDT collab; no full observability suite; no WS push
- Metrics: aggregate from `runs` only; no new metrics tables

**Follow-up (do not implement):** CRDT; WS; alert product; template marketplace; Subflow input/output maps; nested run rows

---

## Key architecture decisions (locked for M5)

| Decision | Choice | Rationale |
|---|---|---|
| Subflow execution | Expand at control plane into flat `JobPayload.graph` | Executor unchanged; M3 timeline/breakpoints work |
| Subflow ref | `config.flow_version_id` published + same workspace | Reproducible runs; matches M1 immutability |
| State across Subflow | Full state inheritance (no map) | YAGNI |
| Templates | Snapshot table + clone → new flow/draft | Builder path without mutating source |
| Metrics | On-read SQL aggregates | Thin v1; no warehouse |
| Executor changes | None required | Flat graph already executable |

---

## File map (create / modify in M5)

```
agent-workflow-orchestrator/
  package.json                                    # + script test:m5
  apps/control-plane/
    src/db/schema.ts                              # + flowTemplates
    src/db/seed.ts                                # Subflow node_def; sample template; optional child flow
    drizzle/0005_m5_templates_metrics.sql
    src/services/subflow-expand.ts                # expandSubflows
    src/services/subflow-expand.test.ts
    src/services/template-service.ts
    src/services/metrics-service.ts
    src/services/metrics-service.test.ts
    src/services/publish-gate.ts                  # + subflow_refs
    src/services/publish-gate.test.ts             # extend
    src/services/run-service.ts                   # expand before dispatch
    src/routes/templates.ts
    src/routes/metrics.ts
    src/index.ts                                  # mount routes
    tests/templates.test.ts
    tests/metrics.test.ts
    tests/m5-integration.test.ts
  apps/web/
    src/api/client.ts                             # templates + metrics + types
    src/api/client.test.ts
    src/templates/TemplatesPanel.tsx
    src/metrics/MetricsPanel.tsx
    src/sample-m5-graph.ts
    src/App.tsx                                   # wire panels + sample
    src/styles/m5.css                             # optional thin styles
  README.md                                       # M5 section
  docs/superpowers/specs/2026-10-22-m5-…           # Status → approved + plan path
  docs/superpowers/specs/2026-10-21-…              # Status += M5 design+plan paths
```

---

### Task 1: `expandSubflows` library + unit tests

**Files:**
- Create: `apps/control-plane/src/services/subflow-expand.ts`
- Create: `apps/control-plane/src/services/subflow-expand.test.ts`

**Interfaces:**
- Consumes: `FlowGraph` from `@awo/graph-schema`
- Produces:
  ```ts
  export type ExpandErrorCode =
    | "subflow_missing_version"
    | "subflow_not_published"
    | "subflow_depth_exceeded"
    | "subflow_cycle"
    | "subflow_invalid_child"
    | "subflow_missing_config";

  export class SubflowExpandError extends Error {
    code: ExpandErrorCode;
    details?: Record<string, unknown>;
  }

  export async function expandSubflows(
    graph: FlowGraph,
    opts: {
      resolvePublished: (flowVersionId: string) => Promise<{
        graph: FlowGraph;
        status: string;
        workspaceOk: boolean;
      } | null>;
      maxDepth?: number; // default 3
      _stack?: string[];
      _depth?: number;
    },
  ): Promise<FlowGraph>;
  ```

- [ ] **Step 1: Write failing tests**

```ts
// apps/control-plane/src/services/subflow-expand.test.ts
import { describe, it, expect } from "vitest";
import { expandSubflows, SubflowExpandError } from "./subflow-expand";
import type { FlowGraph } from "@awo/graph-schema";

const child: FlowGraph = {
  id: "fv_child",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "t", type: "Transform", config: { set: { k: 1 } }, ui: { x: 40, y: 0 } },
    { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "s", sourceHandle: "out", target: "t", targetHandle: "in", kind: "default", label: "" },
    { id: "e2", source: "t", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
  ],
};

const parent: FlowGraph = {
  id: "fv_parent",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "ps", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "sf", type: "Subflow", config: { flow_version_id: "fv_child" }, ui: { x: 40, y: 0 } },
    { id: "pe", type: "End", config: {}, ui: { x: 80, y: 0 } },
  ],
  edges: [
    { id: "p1", source: "ps", sourceHandle: "out", target: "sf", targetHandle: "in", kind: "default", label: "" },
    { id: "p2", source: "sf", sourceHandle: "out", target: "pe", targetHandle: "in", kind: "default", label: "" },
  ],
};

describe("expandSubflows", () => {
  it("inlines child with prefixed ids", async () => {
    const out = await expandSubflows(parent, {
      resolvePublished: async (id) =>
        id === "fv_child"
          ? { graph: child, status: "published", workspaceOk: true }
          : null,
    });
    expect(out.nodes.some((n) => n.type === "Subflow")).toBe(false);
    expect(out.nodes.map((n) => n.id)).toContain("sf__s");
    expect(out.nodes.map((n) => n.id)).toContain("sf__t");
    expect(out.edges.some((e) => e.target === "sf__s")).toBe(true);
    expect(out.edges.some((e) => e.source === "sf__e")).toBe(true);
  });

  it("rejects cycles", async () => {
    await expect(
      expandSubflows(parent, {
        resolvePublished: async () => ({
          graph: {
            ...child,
            nodes: [
              ...child.nodes,
              { id: "loop", type: "Subflow", config: { flow_version_id: "fv_child" }, ui: { x: 1, y: 1 } },
            ],
          },
          status: "published",
          workspaceOk: true,
        }),
      }),
    ).rejects.toMatchObject({ code: "subflow_cycle" });
  });

  it("rejects missing version", async () => {
    await expect(
      expandSubflows(parent, { resolvePublished: async () => null }),
    ).rejects.toBeInstanceOf(SubflowExpandError);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

Run: `pnpm --filter @awo/control-plane exec vitest run src/services/subflow-expand.test.ts`  
Expected: FAIL cannot find module

- [ ] **Step 3: Implement `subflow-expand.ts`**

```ts
import type { FlowGraph, GraphEdge, GraphNode } from "@awo/graph-schema";

export type ExpandErrorCode =
  | "subflow_missing_version"
  | "subflow_not_published"
  | "subflow_depth_exceeded"
  | "subflow_cycle"
  | "subflow_invalid_child"
  | "subflow_missing_config";

export class SubflowExpandError extends Error {
  code: ExpandErrorCode;
  details?: Record<string, unknown>;
  constructor(code: ExpandErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function prefixId(prefix: string, id: string): string {
  return `${prefix}__${id}`;
}

export async function expandSubflows(
  graph: FlowGraph,
  opts: {
    resolvePublished: (flowVersionId: string) => Promise<{
      graph: FlowGraph;
      status: string;
      workspaceOk: boolean;
    } | null>;
    maxDepth?: number;
    _stack?: string[];
    _depth?: number;
  },
): Promise<FlowGraph> {
  const maxDepth = opts.maxDepth ?? 3;
  const depth = opts._depth ?? 0;
  const stack = opts._stack ?? [];
  if (depth > maxDepth) {
    throw new SubflowExpandError("subflow_depth_exceeded", `max depth ${maxDepth}`);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [...graph.edges];
  const replacements: {
    subflowId: string;
    startId: string;
    endId: string;
    childNodes: GraphNode[];
    childEdges: GraphEdge[];
  }[] = [];

  for (const node of graph.nodes) {
    if (node.type !== "Subflow") {
      nodes.push(node);
      continue;
    }
    const fvId = String((node.config as { flow_version_id?: unknown }).flow_version_id ?? "");
    if (!fvId) {
      throw new SubflowExpandError("subflow_missing_config", `node ${node.id} missing flow_version_id`);
    }
    if (stack.includes(fvId)) {
      throw new SubflowExpandError("subflow_cycle", `cycle at ${fvId}`, { flow_version_id: fvId });
    }
    const resolved = await opts.resolvePublished(fvId);
    if (!resolved || !resolved.workspaceOk) {
      throw new SubflowExpandError("subflow_missing_version", `unknown ${fvId}`, { flow_version_id: fvId });
    }
    if (resolved.status !== "published") {
      throw new SubflowExpandError("subflow_not_published", `${fvId} not published`, { flow_version_id: fvId });
    }
    const expandedChild = await expandSubflows(resolved.graph, {
      ...opts,
      _stack: [...stack, fvId],
      _depth: depth + 1,
    });
    const starts = expandedChild.nodes.filter((n) => n.type === "Start");
    const ends = expandedChild.nodes.filter((n) => n.type === "End");
    if (starts.length !== 1 || ends.length !== 1) {
      throw new SubflowExpandError("subflow_invalid_child", "child needs exactly one Start and one End", {
        flow_version_id: fvId,
      });
    }
    const childNodes = expandedChild.nodes.map((n) => ({
      ...n,
      id: prefixId(node.id, n.id),
    }));
    const childEdges = expandedChild.edges.map((e) => ({
      ...e,
      id: prefixId(node.id, e.id),
      source: prefixId(node.id, e.source),
      target: prefixId(node.id, e.target),
    }));
    replacements.push({
      subflowId: node.id,
      startId: prefixId(node.id, starts[0]!.id),
      endId: prefixId(node.id, ends[0]!.id),
      childNodes,
      childEdges,
    });
  }

  let nextEdges = edges;
  for (const rep of replacements) {
    nodes.push(...rep.childNodes);
    nextEdges = nextEdges.map((e) => {
      let source = e.source;
      let target = e.target;
      if (target === rep.subflowId) target = rep.startId;
      if (source === rep.subflowId) source = rep.endId;
      return { ...e, source, target };
    });
    nextEdges = [...nextEdges, ...rep.childEdges];
  }

  return {
    ...graph,
    nodes,
    edges: nextEdges.filter((e) => e.source !== e.target || true),
  };
}
```

(Implement carefully: filter out any edge still referencing removed Subflow ids; do not keep placeholder Subflow nodes.)

- [ ] **Step 4: Re-run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/services/subflow-expand.ts \
  apps/control-plane/src/services/subflow-expand.test.ts
git commit -m "feat(m5): expandSubflows flattens published child graphs"
```

---

### Task 2: Migration `0005_m5_templates_metrics` + seed Subflow + sample template

**Files:**
- Modify: `apps/control-plane/src/db/schema.ts`
- Create: `apps/control-plane/drizzle/0005_m5_templates_metrics.sql`
- Modify: `apps/control-plane/src/db/seed.ts`
- Update drizzle meta journal if the repo uses `drizzle-kit` journal (match M4 pattern in `drizzle/meta`)

**Interfaces:**
- Produces Drizzle table `flowTemplates` and seed rows for `Subflow` node_def + at least one `flow_templates` row

- [ ] **Step 1: Add schema**

```ts
export const flowTemplates = pgTable(
  "flow_templates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    graphJson: jsonb("graph_json").notNull(),
    sourceFlowVersionId: text("source_flow_version_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("flow_templates_workspace_name").on(t.workspaceId, t.name)],
);
```

- [ ] **Step 2: SQL migration**

```sql
CREATE TABLE IF NOT EXISTS "flow_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "graph_json" jsonb NOT NULL,
  "source_flow_version_id" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "flow_templates_workspace_name"
  ON "flow_templates" ("workspace_id", "name");
```

- [ ] **Step 3: Seed**

- Add `Subflow` to `NODE_TYPES` / `UI_META` (color purple, icon nest) / category `control` / `min_role: builder`
- `configSchemaFor("Subflow")` → `{ type: "object", required: ["flow_version_id"], properties: { flow_version_id: { type: "string" } } }`
- Insert template `tpl_demo_basic` with Start→Transform→End graph for `ws_demo`
- Optional but recommended for integration: ensure a published child flow exists (create in seed **or** leave to integration test harness)

- [ ] **Step 4: Apply migration locally**

Run: `pnpm db:up` (if needed) then apply SQL the same way M4 did (project’s existing migrate script / `psql` / drizzle push). Confirm table exists.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/db/schema.ts apps/control-plane/src/db/seed.ts \
  apps/control-plane/drizzle/0005_m5_templates_metrics.sql apps/control-plane/drizzle/meta
git commit -m "feat(m5): flow_templates table, Subflow node_def, demo template seed"
```

---

### Task 3: Templates service + routes + clone

**Files:**
- Create: `apps/control-plane/src/services/template-service.ts`
- Create: `apps/control-plane/src/routes/templates.ts`
- Create: `apps/control-plane/tests/templates.test.ts`
- Modify: `apps/control-plane/src/index.ts` (mount)

**Interfaces:**
- Consumes: `flowTemplates`, `flows`, `flowVersions`, `projects`, `requireRole`, `hashGraph`, `newId`
- Produces:
  ```ts
  listTemplates(workspaceId: string)
  getTemplate(id, workspaceId)
  createTemplateFromPublished(workspaceId, userId, role, { name, description?, flow_version_id })
  deleteTemplate(id, workspaceId, role)
  cloneTemplate(id, workspaceId, userId, role, { project_id, name })
  // → { id: flowId, name }
  ```

- [ ] **Step 1: Failing HTTP tests**

```ts
it("developer creates template from published; builder clones", async () => {
  // arrange: publish a tiny flow as u_dev (bootstrap gate)
  // POST /templates { name: "t1", flow_version_id }
  // POST /templates/:id/clone { project_id: "p_demo", name: "from tpl" } as u_builder
  // GET /flows/:newId → graph nodes length > 0
});

it("viewer cannot create template", async () => {
  const res = await app.request("/templates", {
    method: "POST",
    headers: { "X-User-Id": "u_viewer", "content-type": "application/json" },
    body: JSON.stringify({ name: "x", flow_version_id: "fv_x" }),
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Implement service**

`createTemplateFromPublished`:

1. `requireRole(role, "developer")`
2. Load `flow_versions` by id; require `status === "published"`
3. Join flow→project→workspace match
4. Insert `flow_templates` with copied `graphJson`

`cloneTemplate`:

1. `requireRole(role, "builder")`
2. Load template in workspace
3. Same transaction shape as `createFlow`, but `graphJson = { ...template.graphJson, id: newVersionId }` and `schemaHash = hashGraph(...)`

- [ ] **Step 3: Routes**

```ts
// GET/POST /templates, GET/DELETE /templates/:id, POST /templates/:id/clone
```

Zod-validate bodies.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(m5): template CRUD and clone-to-draft flow"
```

---

### Task 4: Wire expand into run dispatch + publish gate `subflow_refs`

**Files:**
- Modify: `apps/control-plane/src/services/run-service.ts`
- Modify: `apps/control-plane/src/services/publish-gate.ts`
- Modify: `apps/control-plane/src/services/publish-gate.test.ts`
- Modify: `apps/control-plane/src/services/executor-client.ts` only if job build is there — expand **once** where `graph` is chosen for the job

**Interfaces:**
- Consumes: `expandSubflows`, DB lookup for published versions + workspace check
- Produces: JobPayload.graph always Subflow-free; gate check `{ id: "subflow_refs", ok, message? }`

- [ ] **Step 1: Resolver helper**

```ts
export async function resolvePublishedForWorkspace(
  flowVersionId: string,
  workspaceId: string,
) {
  const ver = await db.query.flowVersions.findFirst({ where: eq(flowVersions.id, flowVersionId) });
  if (!ver) return null;
  const flow = await db.query.flows.findFirst({ where: eq(flows.id, ver.flowId) });
  if (!flow) return null;
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, flow.projectId), eq(projects.workspaceId, workspaceId)),
  });
  return {
    graph: ver.graphJson as FlowGraph,
    status: ver.status,
    workspaceOk: Boolean(project),
  };
}
```

- [ ] **Step 2: Expand in create/dispatch path**

After loading the version graph (published or draft), before `dispatchJob`:

```ts
const flat = await expandSubflows(graph, {
  resolvePublished: (id) => resolvePublishedForWorkspace(id, workspaceId),
});
// send flat in JobPayload; persist run still points at parent flow_version_id
```

Map `SubflowExpandError` → HTTP 400 with `{ error: err.code, details: err.details }`.

- [ ] **Step 3: Gate check**

In `evaluatePublishGate`, after existing checks:

```ts
try {
  await expandSubflows(draftGraph, {
    resolvePublished: (id) => resolvePublishedForWorkspace(id, workspaceId),
  });
  checks.push({ id: "subflow_refs", ok: true });
} catch (e) {
  const err = e as SubflowExpandError;
  checks.push({
    id: "subflow_refs",
    ok: false,
    message: err instanceof SubflowExpandError ? `${err.code}: ${err.message}` : "subflow expand failed",
  });
}
```

Also fail `required_config` when Subflow misses `flow_version_id` (seed schema already requires it).

- [ ] **Step 4: Unit tests for gate**

- Draft with bad `flow_version_id` → `subflow_refs` ok=false
- Draft with valid published child → ok=true

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(m5): expand Subflow on dispatch; publish gate subflow_refs"
```

---

### Task 5: Metrics service + routes

**Files:**
- Create: `apps/control-plane/src/services/metrics-service.ts`
- Create: `apps/control-plane/src/services/metrics-service.test.ts`
- Create: `apps/control-plane/src/routes/metrics.ts`
- Create: `apps/control-plane/tests/metrics.test.ts`
- Modify: `apps/control-plane/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  getFlowMetrics(flowId, workspaceId, { from?: Date; to?: Date; trigger?: string })
  getWorkspaceMetrics(workspaceId, { from?: Date; to?: Date; trigger?: string })
  ```

- [ ] **Step 1: Failing unit test with fixture math**

```ts
it("computes success_rate and avg_latency_ms", () => {
  const rows = [
    { status: "succeeded", startedAt: new Date("2026-10-22T00:00:00Z"), finishedAt: new Date("2026-10-22T00:00:02Z"), costTokens: 10, flowVersionId: "fv1", version: 1, versionStatus: "published" },
    { status: "failed", startedAt: new Date("2026-10-22T00:00:00Z"), finishedAt: new Date("2026-10-22T00:00:01Z"), costTokens: 5, flowVersionId: "fv1", version: 1, versionStatus: "published" },
  ];
  const agg = aggregateRunRows(rows);
  expect(agg.totals.succeeded).toBe(1);
  expect(agg.totals.failed).toBe(1);
  expect(agg.totals.success_rate).toBeCloseTo(0.5);
  expect(agg.totals.avg_latency_ms).toBeCloseTo(1500);
  expect(agg.totals.sum_cost_tokens).toBe(15);
});
```

Export pure `aggregateRunRows` for unit test without DB.

- [ ] **Step 2: Implement SQL fetch + aggregate**

- Completed = status in `succeeded|failed|cancelled`
- `success_rate = succeeded / completed` (0 if completed=0)
- `in_flight` = count where status in `queued|running|paused|cancel_requested`
- Group `by_version` on `flow_version_id`

- [ ] **Step 3: Routes**

`GET /metrics/flows/:flowId` and `GET /metrics/workspace` — `requireRole` not needed beyond auth; viewer+ implied by any membership. Return 404 if flow outside workspace.

- [ ] **Step 4: HTTP test** — insert/use existing runs; assert JSON keys present

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(m5): thin flow/workspace metrics from runs"
```

---

### Task 6: M5 integration test + `test:m5` script

**Files:**
- Create: `apps/control-plane/tests/m5-integration.test.ts`
- Modify: root `package.json` (`test:m5`)

**Interfaces:**
- Consumes: live app + DB + executor (same pattern as `test:m3` / `test:m4`)
- Produces: green `pnpm test:m5`

- [ ] **Step 1: Scenarios**

```ts
describe("m5 integration", () => {
  it("publish child, parent Subflow expands and test-run succeeds", async () => {
    // 1) create+publish child Start→Transform→End (bootstrap)
    // 2) parent Start→Subflow(child published id)→End; developer draft test-run or bootstrap publish
    // 3) create test run; wait succeeded
    // 4) GET events — expect node_id like "%__%" child prefix OR Transform under prefix
  });

  it("publish gate rejects bad subflow ref", async () => {
    // draft Subflow flow_version_id=fv_missing → publish 400 checks includes subflow_refs
  });

  it("template create + clone yields editable draft", async () => { /* ... */ });

  it("metrics totals move after succeeded run", async () => {
    // GET /metrics/flows/:id → runs >= 1, success_rate defined
  });
});
```

- [ ] **Step 2: Add script**

```json
"test:m5": "DATABASE_URL=${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo} EXECUTOR_TOKEN=${EXECUTOR_TOKEN:-test-executor-token-m5} pnpm --filter @awo/control-plane exec vitest run tests/m5-integration.test.ts"
```

- [ ] **Step 3: Run `pnpm test:m5` — PASS; smoke `pnpm test:m4` still PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "test(m5): integration for subflow expand, templates, metrics"
```

---

### Task 7: Web — templates panel, metrics panel, M5 sample + docs

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`
- Create: `apps/web/src/templates/TemplatesPanel.tsx`
- Create: `apps/web/src/metrics/MetricsPanel.tsx`
- Create: `apps/web/src/sample-m5-graph.ts` (parent with Subflow placeholder comment / instructions; or load child version id from status after publish helper)
- Modify: `apps/web/src/App.tsx`
- Optional: `apps/web/src/styles/m5.css`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-22-m5-subflow-templates-metrics-design.md` (Status → approved)
- Modify: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (Status += M5 paths — if not already updated when this plan was written)

**Interfaces:**
- Client:
  ```ts
  listTemplates(): Promise<TemplateSummary[]>
  createTemplate(body: { name: string; description?: string; flow_version_id: string })
  cloneTemplate(id: string, body: { project_id: string; name: string }): Promise<{ id: string; name: string }>
  getFlowMetrics(flowId: string, q?: { from?: string; to?: string }): Promise<FlowMetrics>
  getWorkspaceMetrics(q?: { from?: string; to?: string }): Promise<WorkspaceMetrics>
  ```

- [ ] **Step 1: Client tests** for listTemplates / getFlowMetrics parsing

- [ ] **Step 2: TemplatesPanel** — list names; button “从模板创建” calls clone with `PROJECT_ID` + name prompt/default; `onCloned(flowId)` callback to App loader

- [ ] **Step 3: MetricsPanel** — when `flowId` set, poll/fetch metrics on button “刷新指标”; show success_rate, avg_latency_ms, sum_cost_tokens

- [ ] **Step 4: App** — mount panels; add “加载 M5 样例” that documents Subflow config needs a published `flow_version_id` (sample may use empty Subflow + status hint, or two-step create in UI copy)

- [ ] **Step 5: README M5 section** — Subflow expand, templates endpoints, metrics, `pnpm test:m5`

- [ ] **Step 6: Design status links** — M5 design Status approved; parent Status lists M5 design+plan

- [ ] **Step 7: Web vitest PASS; commit**

```bash
git commit -m "feat(m5): web templates/metrics panels and README"
```

---

## Self-review (plan vs design)

| Spec section | Task coverage |
|---|---|
| §3 Subflow config + expand | Task 1 |
| §3.2 maxDepth/cycle/prefix | Task 1 |
| §3.3 publish gate `subflow_refs` | Task 4 |
| §3.4 roles | Tasks 3–4 (existing requireRole) |
| §4 Templates table/API/clone | Tasks 2–3 |
| §4.3 Seed | Task 2 |
| §5 Metrics API | Task 5 |
| §6 Web UI | Task 7 |
| §7 Acceptance | Task 6 integration |
| YAGNI (no CRDT/WS/warehouse) | Global Constraints; no tasks add them |
| Executor unchanged | Locked decision; no executor task |

Placeholder scan: no TBD/TODO steps; commands and example tests inlined.  
Type consistency: `flow_version_id`, `ExpandErrorCode`, `subflow_refs`, `flow_templates`, metrics field names aligned across tasks.
