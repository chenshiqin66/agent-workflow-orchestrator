# M1 Graph Canvas + Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working monorepo where a user can create a flow, edit a draft graph on a styled XYFlow canvas, persist versions, and publish an immutable `flow_version`.

**Architecture:** pnpm monorepo with `packages/graph-schema` (shared Zod/JSON Schema), `apps/control-plane` (Hono + Drizzle + PostgreSQL), and `apps/web` (Vite + React + XYFlow). M1 has no executor; publish only freezes `graph_json`. Auth is a stub (`X-User-Id` + seeded membership) until M4.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Vite, React 18, `@xyflow/react`, Hono, Drizzle ORM, PostgreSQL 16, Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`

## Global Constraints

- Product: 编排画布 + 运行时调试（runtime execution starts in M2, not M1）
- Deploy shape: 前后端分离；M1 ships `apps/web` + `apps/control-plane` only
- Dual personas later: `admin` | `developer` | `builder` | `viewer` — M1 seeds one developer user
- Graph is language-agnostic JSON; secrets never appear inside `graph_json`
- Published `flow_versions` are immutable; edits create/update draft only
- UI style: light blue/white; rounded nodes with left icon; port dots; success edges blue; failure edges red/orange; edge labels; diamond for decision (`Branch`)
- DB: PostgreSQL
- Monorepo: pnpm
- Auth M1: stub header `X-User-Id` (no OIDC yet)
- Executor transport: deferred to M2 (HTTP callback)

**Follow-up plans (do not implement in this plan):** M2 executor + test run timeline; M3 breakpoint/signal; M4 roles/assets/publish gate; M5 subflow/templates/metrics.

---

## File map (create in M1)

```
agent-workflow-orchestrator/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  docker-compose.yml
  packages/graph-schema/
    package.json
    src/index.ts
    src/graph.ts
    src/hash.ts
    src/graph.test.ts
  apps/control-plane/
    package.json
    src/index.ts
    src/db/schema.ts
    src/db/client.ts
    src/db/seed.ts
    src/middleware/auth.ts
    src/routes/flows.ts
    src/routes/flow-versions.ts
    src/routes/node-defs.ts
    src/services/flow-service.ts
    tests/flows.test.ts
  apps/web/
    package.json
    index.html
    src/main.tsx
    src/App.tsx
    src/api/client.ts
    src/canvas/FlowCanvas.tsx
    src/canvas/nodes/BaseNode.tsx
    src/canvas/nodes/DecisionNode.tsx
    src/canvas/edges/LabeledEdge.tsx
    src/styles/canvas.css
```

---

### Task 1: Monorepo scaffold + Postgres

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `apps/control-plane/package.json`, `apps/web/package.json`, `packages/graph-schema/package.json`
- Test: `pnpm -r exec tsc --noEmit` after stub entry files exist

**Interfaces:**
- Consumes: none
- Produces: workspace packages `@awo/graph-schema`, `@awo/control-plane`, `@awo/web`; Postgres on `localhost:5432`, db `awo`, user/password `awo`/`awo`

- [ ] **Step 1: Write root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Root `package.json`:
```json
{
  "name": "agent-workflow-orchestrator",
  "private": true,
  "scripts": {
    "dev:api": "pnpm --filter @awo/control-plane dev",
    "dev:web": "pnpm --filter @awo/web dev",
    "test": "pnpm -r test",
    "db:up": "docker compose up -d postgres"
  },
  "engines": { "node": ">=20" }
}
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: awo
      POSTGRES_PASSWORD: awo
      POSTGRES_DB: awo
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```

- [ ] **Step 2: Create package stubs**

Each package gets `"type": "module"`, TypeScript, and a minimal `src/index.ts` exporting a const `PACKAGE = "name"`.

`packages/graph-schema/package.json` name: `@awo/graph-schema`, scripts: `"test": "vitest run"`.

`apps/control-plane/package.json` name: `@awo/control-plane`, deps: `hono`, `drizzle-orm`, `postgres`, `zod`, `@awo/graph-schema`.

`apps/web/package.json` name: `@awo/web`, deps: `react`, `react-dom`, `@xyflow/react`, `@awo/graph-schema`.

- [ ] **Step 3: Start Postgres and verify**

```bash
cd /workspace/agent-workflow-orchestrator
pnpm install
pnpm db:up
docker compose ps
```

Expected: `postgres` state running, port 5432.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json docker-compose.yml apps packages
git commit -m "chore: scaffold pnpm monorepo and postgres"
```

---

### Task 2: `@awo/graph-schema` — Zod graph + content hash

**Files:**
- Create: `packages/graph-schema/src/graph.ts`, `packages/graph-schema/src/hash.ts`, `packages/graph-schema/src/index.ts`
- Test: `packages/graph-schema/src/graph.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `EdgeKind = "success" | "failure" | "default"`
  - `GraphNode`, `GraphEdge`, `FlowGraph` Zod types
  - `parseFlowGraph(input: unknown): FlowGraph`
  - `hashGraph(graph: FlowGraph): string` (sha256 of canonical JSON)

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseFlowGraph, hashGraph } from "./index";

describe("parseFlowGraph", () => {
  it("accepts a minimal start-end graph", () => {
    const g = parseFlowGraph({
      id: "fv1",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
      ],
      edges: [
        {
          id: "e1",
          source: "s",
          sourceHandle: "out",
          target: "e",
          targetHandle: "in",
          kind: "default",
          label: "",
        },
      ],
    });
    expect(g.nodes).toHaveLength(2);
  });

  it("rejects unknown edge kind", () => {
    expect(() =>
      parseFlowGraph({
        id: "fv1",
        state_schema: { type: "object", properties: {} },
        nodes: [],
        edges: [
          {
            id: "e1",
            source: "a",
            sourceHandle: "out",
            target: "b",
            targetHandle: "in",
            kind: "nope",
          },
        ],
      })
    ).toThrow();
  });
});

describe("hashGraph", () => {
  it("is stable for same content regardless of key order", () => {
    const a = parseFlowGraph({
      id: "fv1",
      state_schema: { type: "object", properties: {} },
      nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 1, y: 2 } }],
      edges: [],
    });
    const b = structuredClone(a);
    expect(hashGraph(a)).toBe(hashGraph(b));
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
pnpm --filter @awo/graph-schema test
```

Expected: FAIL module not found or exports missing.

- [ ] **Step 3: Implement schema + hash**

`graph.ts` — Zod:

```ts
import { z } from "zod";

export const EdgeKindSchema = z.enum(["success", "failure", "default"]);

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  ui: z.object({
    x: z.number(),
    y: z.number(),
    variant: z.string().optional(),
  }),
});

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
  targetHandle: z.string().min(1),
  kind: EdgeKindSchema.default("default"),
  label: z.string().optional().default(""),
});

export const FlowGraphSchema = z.object({
  id: z.string().min(1),
  state_schema: z.record(z.unknown()),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

export type FlowGraph = z.infer<typeof FlowGraphSchema>;

export function parseFlowGraph(input: unknown): FlowGraph {
  return FlowGraphSchema.parse(input);
}
```

`hash.ts`:

```ts
import { createHash } from "node:crypto";
import type { FlowGraph } from "./graph";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function hashGraph(graph: FlowGraph): string {
  const canonical = JSON.stringify(sortKeys(graph));
  return createHash("sha256").update(canonical).digest("hex");
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm --filter @awo/graph-schema test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/graph-schema
git commit -m "feat(graph-schema): add FlowGraph zod schema and content hash"
```

---

### Task 3: Control-plane DB schema + seed

**Files:**
- Create: `apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/client.ts`, `apps/control-plane/src/db/seed.ts`, `apps/control-plane/drizzle.config.ts`
- Test: `apps/control-plane/tests/db-seed.test.ts` (connects to Postgres; skip if `DATABASE_URL` missing)

**Interfaces:**
- Consumes: none
- Produces: Drizzle tables matching spec E-R for M1 subset: `users`, `workspaces`, `memberships`, `projects`, `flows`, `flow_versions`, `node_defs`, `audit_logs`
- Produces seed: user `u_dev`, workspace `ws_demo`, project `p_demo`, membership role `developer`, node_defs for `Start|End|Branch|HTTP|LLM`

- [ ] **Step 1: Write failing seed test**

```ts
import { describe, it, expect } from "vitest";
import { db } from "../src/db/client";
import { nodeDefs, users } from "../src/db/schema";

describe("seed", () => {
  it("has developer user and core node defs", async () => {
    const u = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.id, "u_dev") });
    expect(u?.email).toBe("dev@example.com");
    const defs = await db.select().from(nodeDefs);
    const keys = defs.map((d) => d.typeKey).sort();
    expect(keys).toEqual(["Branch", "End", "HTTP", "LLM", "Start"]);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
DATABASE_URL=postgres://awo:awo@localhost:5432/awo pnpm --filter @awo/control-plane test
```

Expected: FAIL (schema/client missing).

- [ ] **Step 3: Implement Drizzle schema (M1 columns)**

Key columns (camelCase in TS, snake_case in DB via Drizzle):

- `flows`: `id`, `projectId`, `name`, `latestDraftVersionId` (nullable text), `publishedVersionId` (nullable text)
- `flow_versions`: `id`, `flowId`, `version` (int), `status` (`draft|published|archived`), `graphJson` (jsonb), `schemaHash` (text), `createdBy`, `createdAt`
- `node_defs`: `id`, `workspaceId`, `typeKey`, `category`, `configSchema` (jsonb), `uiMeta` (jsonb), `minRole`

Include FK-ish fields as text ids for speed in M1; add real FKs if time permits.

- [ ] **Step 4: Migrate + seed**

```bash
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed
```

Seed `uiMeta` examples:

```json
{ "Start": { "color": "blue", "icon": "user", "shape": "rounded" },
  "Branch": { "color": "blue", "icon": "scales", "shape": "diamond" },
  "HTTP": { "color": "blue", "icon": "database", "shape": "rounded" },
  "LLM": { "color": "blue", "icon": "bulb", "shape": "rounded" },
  "End": { "color": "green", "icon": "chat", "shape": "rounded" } }
```

- [ ] **Step 5: Run test — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane
git commit -m "feat(control-plane): add drizzle schema and demo seed"
```

---

### Task 4: Flow + draft version API

**Files:**
- Create: `apps/control-plane/src/middleware/auth.ts`, `apps/control-plane/src/services/flow-service.ts`, `apps/control-plane/src/routes/flows.ts`, `apps/control-plane/src/routes/flow-versions.ts`, `apps/control-plane/src/index.ts`
- Test: `apps/control-plane/tests/flows.test.ts`

**Interfaces:**
- Consumes: `parseFlowGraph`, `hashGraph` from `@awo/graph-schema`
- Produces HTTP:
  - `POST /projects/:projectId/flows` body `{ name }` → `{ id, name }`
  - `GET /flows/:flowId` → flow + latest draft graph
  - `PUT /flows/:flowId/draft` body `{ graph }` → validates, upserts draft `flow_versions`, updates `latest_draft_version_id`, returns `{ versionId, schemaHash, version }`
  - `POST /flows/:flowId/publish` → copies draft to new `published` version OR marks current draft published **once**; sets `published_version_id`; rejects if no draft; never mutates an already `published` row
  - `GET /node-defs` → list for workspace (header user)

Auth middleware: read `X-User-Id`, load membership, set `c.set("userId", ...)`, `c.set("workspaceId", ...)`.

- [ ] **Step 1: Write failing API tests** (use Hono `app.request`)

```ts
it("creates flow, saves draft, publishes immutable version", async () => {
  const headers = { "X-User-Id": "u_dev", "Content-Type": "application/json" };
  const created = await app.request("/projects/p_demo/flows", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "客服流水线" }),
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();

  const graph = {
    id: "tmp",
    state_schema: { type: "object", properties: {} },
    nodes: [
      { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
      { id: "b", type: "Branch", config: {}, ui: { x: 160, y: 0, variant: "decision" } },
      { id: "ok", type: "End", config: {}, ui: { x: 320, y: -40 } },
      { id: "bad", type: "End", config: {}, ui: { x: 320, y: 40 } },
    ],
    edges: [
      { id: "e0", source: "s", sourceHandle: "out", target: "b", targetHandle: "in", kind: "default", label: "" },
      { id: "e1", source: "b", sourceHandle: "success", target: "ok", targetHandle: "in", kind: "success", label: "查询成功" },
      { id: "e2", source: "b", sourceHandle: "failure", target: "bad", targetHandle: "in", kind: "failure", label: "查询失败" },
    ],
  };

  const saved = await app.request(`/flows/${id}/draft`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ graph }),
  });
  expect(saved.status).toBe(200);
  const draft = await saved.json();
  expect(draft.schemaHash).toMatch(/^[a-f0-9]{64}$/);

  const pub = await app.request(`/flows/${id}/publish`, { method: "POST", headers });
  expect(pub.status).toBe(200);
  const published = await pub.json();
  expect(published.status).toBe("published");

  // mutate published row must not be possible via draft overwrite of same version id
  const again = await app.request(`/flows/${id}/draft`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ graph: { ...graph, nodes: graph.nodes.slice(0, 1) } }),
  });
  expect(again.status).toBe(200);
  const draft2 = await again.json();
  expect(draft2.versionId).not.toBe(published.versionId);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement service + routes**

Publish rules:

1. Load flow + latest draft version where `status === "draft"`.
2. If missing → `400`.
3. Set draft row to `published` **or** insert cloned row with `status=published` and bump `version`; prefer **update in place only if never published before**, else always insert new published snapshot from current draft JSON then keep a fresh draft copy. Simplest correct approach:
   - Read draft `graph_json`
   - Insert new `flow_versions` with `status=published`, `version = max+1`
   - Update `flows.published_version_id`
   - Leave existing draft row as draft (or clone draft forward)
4. Write `audit_logs` row `flow.publish`.

On `PUT draft`: `parseFlowGraph`, set `graph.id` to version id, `schemaHash = hashGraph(graph)`, upsert draft.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control-plane): flow draft save and immutable publish"
```

---

### Task 5: Canvas UI baseline (style reference)

**Files:**
- Create: `apps/web/src/canvas/FlowCanvas.tsx`, `apps/web/src/canvas/nodes/BaseNode.tsx`, `apps/web/src/canvas/nodes/DecisionNode.tsx`, `apps/web/src/canvas/edges/LabeledEdge.tsx`, `apps/web/src/styles/canvas.css`, `apps/web/src/App.tsx`
- Test: `apps/web/src/canvas/graph-adapter.test.ts` (pure functions mapping API graph ↔ XYFlow)

**Interfaces:**
- Consumes: `FlowGraph` type from `@awo/graph-schema`
- Produces:
  - `toXyflow(graph: FlowGraph): { nodes: Node[]; edges: Edge[] }`
  - `fromXyflow(nodes, edges, graphId): FlowGraph`
  - Visual: blue success edges, red failure edges, diamond `Branch`, title area optional

- [ ] **Step 1: Write adapter tests**

```ts
it("round-trips handles and edge kinds", () => {
  const graph = /* same sample as API test */;
  const { nodes, edges } = toXyflow(graph);
  expect(edges.find((e) => e.id === "e1")?.style?.stroke).toBeDefined();
  const back = fromXyflow(nodes, edges, graph.id);
  expect(back.edges.map((e) => e.kind).sort()).toEqual(["default", "failure", "success"]);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement nodes/edges CSS**

`canvas.css` tokens:

```css
:root {
  --awo-bg: linear-gradient(180deg, #eaf6ff, #f7fbff);
  --awo-node-blue: #3b82f6;
  --awo-node-green: #22c55e;
  --awo-node-orange: #f97316;
  --awo-edge-success: #3b82f6;
  --awo-edge-failure: #ef4444;
}
```

`DecisionNode`: CSS rotate square 45deg or SVG diamond; ports on corners/sides mapped to `success` / `failure`.

`LabeledEdge`: use XYFlow `EdgeLabelRenderer` to show `data.label`.

- [ ] **Step 4: Run adapter tests — PASS**

- [ ] **Step 5: Manual check**

```bash
pnpm --filter @awo/web dev
```

Open canvas with hardcoded sample graph matching the style reference path (用户问题 → 判断 → 成功/失败).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(web): XYFlow canvas baseline with success/failure edge styles"
```

---

### Task 6: Wire canvas to control-plane

**Files:**
- Create: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/canvas/FlowCanvas.tsx`
- Test: `apps/web/src/api/client.test.ts` (mock `fetch`)

**Interfaces:**
- Consumes: Task 4 HTTP API
- Produces: UI actions `Load flow`, `Save draft`, `Publish` calling API with `X-User-Id: u_dev`; debounce save optional (≥300ms) but explicit Save button required in M1

- [ ] **Step 1: Write client unit test with mock fetch for saveDraft**

- [ ] **Step 2: Implement client + App wiring**

Env: `VITE_API_BASE=http://localhost:8787`

CORS: enable on Hono for that origin.

- [ ] **Step 3: End-to-end smoke (manual script)**

```bash
pnpm db:up
pnpm --filter @awo/control-plane db:seed
pnpm --filter @awo/control-plane dev   # :8787
pnpm --filter @awo/web dev             # :5173
```

Checklist:

1. Create/open demo flow
2. Drag `Branch`, connect success/failure edges with labels
3. Save draft → refresh → graph restored
4. Publish → call `GET` flow → `publishedVersionId` set; second edit + save creates new draft hash without altering published row

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): wire canvas save/publish to control-plane API"
```

---

### Task 7: M1 README + acceptance checklist

**Files:**
- Create: `README.md`
- Modify: spec status line to note M1 plan exists (optional)

- [ ] **Step 1: Write README** with setup commands and M1 acceptance criteria copied from Task 6 checklist

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add M1 README and local run instructions"
```

---

## Spec coverage (self-review)

| Spec item | Plan task |
|---|---|
| Option A control plane TS | Task 1, 4 |
| Graph JSON schema | Task 2 |
| E-R subset for flows/versions/node_defs | Task 3 |
| Draft + immutable publish | Task 4 |
| Canvas style reference | Task 5 |
| CRUD + version + publish M1 | Task 4, 6 |
| Runtime/executor/debug | Out of scope → M2 plan |
| Roles/assets/publish gate | Out of scope → M4 plan |
| Subflow/templates/metrics | Out of scope → M5 plan |

## Placeholder / consistency check

- Types use `FlowGraph`, `kind: success|failure|default` consistently
- IDs `u_dev`, `p_demo`, `ws_demo` consistent across seed and tests
- No TBD steps remaining

---

## Execution handoff

After this plan is approved for execution, choose:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — execute in this session with checkpoints
