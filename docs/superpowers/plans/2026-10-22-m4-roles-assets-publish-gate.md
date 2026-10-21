# M4 Roles + Asset Registry + Publish Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce workspace roles for node visibility and mutating APIs; add minimal tools/models/knowledge_bases registry CRUD; block publish unless required config and a successful matching test-run pass (with first-publish bootstrap).

**Architecture:** Keep stub `X-User-Id` → `memberships.role`. Introduce `roleAtLeast` rank helper; filter `GET /node-defs` by `min_role`; gate `publishFlow` with structured checks; relax test-run to allow `graph_source: "draft"` for developer+. New Drizzle tables + `/assets/*` routes. Web: user switcher, server-filtered palette, thin assets panel, publish gate error display. No OIDC, no secrets vault, no multi-approver workflow.

**Tech Stack:** Existing M1–M3 stack — TypeScript, pnpm, Hono, Drizzle, PostgreSQL, Vite, React, XYFlow, Vitest, Zod. Paths use `apps/control-plane` (not `apps/api`).

**Spec:** `docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md`

## Global Constraints

- Product: 编排画布 + 运行时调试 — M4 ships **roles + assets + publish gate**; subflow/templates/metrics are M5
- Auth: stub `X-User-Id` only; executor callbacks `X-Executor-Token` unchanged
- Roles exact: `admin | developer | builder | viewer` with ranks 3/2/1/0
- Graph is language-agnostic JSON; secrets never inside `graph_json` (asset `config_json` may hold opaque `secret_ref` strings only — no vault)
- Do not change M1 publish immutability (new published row; draft untouched)
- Do not change M3 pause/signal/checkpoint behavior
- Default test-run remains **published**; draft test-run is developer+/admin only
- Publish gate bootstrap: skip `successful_test_run` when `publishedVersionId` is null
- Migration name exact: `0004_m4_roles_assets_gate`
- No OIDC; no multi-approver publish; no `credentials` table in M4

**Follow-up plans (do not implement in this plan):** M5 subflow/templates/metrics; OIDC; secrets vault; WS push.

---

## Key architecture decisions (locked for M4)

| Decision | Choice | Rationale |
|---|---|---|
| Auth | Keep `X-User-Id` + memberships | Spec YAGNI; matches M1–M3 |
| Role check helper | `roleAtLeast(role, min)` via numeric rank | One function for routes + node filter + gate |
| Node visibility | Server-side filter on `GET /node-defs` | Builders never see Code ids |
| Draft test-run | `graph_source: "draft"` on create run; developer+ | Solves publish-gate chicken-and-egg without fake publish |
| Gate failure shape | `400` `{ error: "publish_gate_failed", checks: [...] }` | Web can render per-check |
| Assets | Three tables; no credentials | Parent E-R subset; no vault |
| Tool list ACL | `allowed_roles` jsonb string[]; empty/missing = all roles | Minimal authorization |
| Code node | Seed `node_defs` only; executor may still stub/fail | Visibility/governance first |

---

## File map (create / modify in M4)

```
agent-workflow-orchestrator/
  package.json                                 # + script test:m4
  apps/control-plane/
    src/auth/roles.ts                          # rank + roleAtLeast + requireRole + ROLE_RANK
    src/auth/roles.test.ts
    src/db/schema.ts                           # + tools, models, knowledge_bases
    src/db/seed.ts                             # multi-user; Code; min_role; sample assets; HTTP required
    drizzle/0004_m4_roles_assets_gate.sql
    src/services/flow-service.ts               # listNodeDefs(role); publish gate; requireRole on mutate
    src/services/publish-gate.ts               # evaluatePublishGate
    src/services/publish-gate.test.ts
    src/services/asset-service.ts              # CRUD tools/models/KBs
    src/services/run-service.ts                # graph_source draft|published; role checks
    src/routes/flows.ts                        # pass role into listNodeDefs
    src/routes/flow-versions.ts                # pass role; map gate errors
    src/routes/runs.ts                         # pass role; parse graph_source
    src/routes/assets.ts                       # new
    src/index.ts                               # mount assets routes
    tests/roles-node-defs.test.ts
    tests/assets.test.ts
    tests/publish-gate.test.ts
    tests/m4-integration.test.ts
  apps/web/
    src/api/client.ts                          # assets API; createRun graph_source; PublishGateError type
    src/api/client.test.ts                     # extend
    src/auth/UserSwitcher.tsx
    src/assets/AssetsPanel.tsx
    src/canvas/NodePalette.tsx                 # from listNodeDefs
    src/App.tsx                                # wire switcher, palette, assets, gate errors
    src/styles/…                               # thin styles if needed
  README.md                                    # M4 section
  docs/superpowers/specs/2026-10-22-m4-…       # Status → approved + plan path
  docs/superpowers/specs/2026-10-21-…           # Status += M4 design+plan paths
```

---

### Task 1: Role helpers + seed multi-user + filter node-defs

**Files:**
- Create: `apps/control-plane/src/auth/roles.ts`
- Create: `apps/control-plane/src/auth/roles.test.ts`
- Modify: `apps/control-plane/src/db/seed.ts`
- Modify: `apps/control-plane/src/services/flow-service.ts` (`listNodeDefs`)
- Modify: `apps/control-plane/src/routes/flows.ts`
- Test: `apps/control-plane/tests/roles-node-defs.test.ts`

**Interfaces:**
- Consumes: `memberships.role`, `nodeDefs.minRole`, existing `authMiddleware` variables
- Produces:
  ```ts
  export const ROLES = ["viewer", "builder", "developer", "admin"] as const;
  export type Role = (typeof ROLES)[number];
  export const ROLE_RANK: Record<Role, number> = {
    viewer: 0, builder: 1, developer: 2, admin: 3,
  };
  export function parseRole(raw: string): Role | null;
  export function roleAtLeast(role: string, minRole: string): boolean;
  export function requireRole(role: string, minRole: string): void; // throws httpError 403
  export async function listNodeDefs(workspaceId: string, role: string): Promise<NodeDefRow[]>;
  ```

- [ ] **Step 1: Write failing unit tests for roles**

```ts
// apps/control-plane/src/auth/roles.test.ts
import { describe, it, expect } from "vitest";
import { roleAtLeast, parseRole } from "./roles";

describe("roleAtLeast", () => {
  it("developer sees builder-min nodes", () => {
    expect(roleAtLeast("developer", "builder")).toBe(true);
  });
  it("builder does not see developer-min nodes", () => {
    expect(roleAtLeast("builder", "developer")).toBe(false);
  });
  it("unknown role denies", () => {
    expect(roleAtLeast("nope", "viewer")).toBe(false);
  });
  it("parseRole accepts admin", () => {
    expect(parseRole("admin")).toBe("admin");
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

Run: `pnpm --filter @awo/control-plane exec vitest run src/auth/roles.test.ts`
Expected: FAIL cannot find module or parseRole undefined

- [ ] **Step 3: Implement `roles.ts`**

```ts
export const ROLES = ["viewer", "builder", "developer", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  builder: 1,
  developer: 2,
  admin: 3,
};

export function parseRole(raw: string): Role | null {
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : null;
}

export function roleAtLeast(role: string, minRole: string): boolean {
  const a = parseRole(role);
  const b = parseRole(minRole);
  if (!a || !b) return false;
  return ROLE_RANK[a] >= ROLE_RANK[b];
}

export function requireRole(role: string, minRole: string): void {
  if (!roleAtLeast(role, minRole)) {
    const err = new Error(`requires role ${minRole}+`);
    (err as Error & { status: number }).status = 403;
    throw err;
  }
}
```

- [ ] **Step 4: Re-run roles unit tests — PASS**

- [ ] **Step 5: Update seed — users + Code + min_role**

In `seed.ts`:
- Upsert users/memberships: `u_admin`/`admin`, `u_dev`/`developer`, `u_builder`/`builder`, `u_viewer`/`viewer`
- Add `Code` to `NODE_TYPES` with `UI_META` / category `integration` (or `agent`)
- Per-type `min_role`: default `builder`; `Code` and `Breakpoint` → `developer`
- For `HTTP`, set `configSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } }`

- [ ] **Step 6: Filter `listNodeDefs(workspaceId, role)`**

```ts
export async function listNodeDefs(workspaceId: string, role: string) {
  const rows = await db.select().from(nodeDefs).where(eq(nodeDefs.workspaceId, workspaceId));
  return rows.filter((d) => roleAtLeast(role, d.minRole));
}
```

Route: `listNodeDefs(c.get("workspaceId"), c.get("role"))`.

- [ ] **Step 7: HTTP test builder vs developer node-defs**

```ts
// apps/control-plane/tests/roles-node-defs.test.ts
it("builder omits Code; developer includes Code", async () => {
  const builder = await app.request("/node-defs", {
    headers: { "X-User-Id": "u_builder" },
  });
  const developer = await app.request("/node-defs", {
    headers: { "X-User-Id": "u_dev" },
  });
  expect(builder.status).toBe(200);
  expect(developer.status).toBe(200);
  const b = (await builder.json()) as { typeKey: string }[];
  const d = (await developer.json()) as { typeKey: string }[];
  expect(b.some((x) => x.typeKey === "Code")).toBe(false);
  expect(d.some((x) => x.typeKey === "Code")).toBe(true);
});
```

Requires DB seed applied in test setup (same pattern as `flows.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/auth apps/control-plane/src/db/seed.ts \
  apps/control-plane/src/services/flow-service.ts apps/control-plane/src/routes/flows.ts \
  apps/control-plane/tests/roles-node-defs.test.ts
git commit -m "feat(m4): role ranks, multi-user seed, filter node-defs by min_role"
```

---

### Task 2: Asset tables migration + asset-service CRUD

**Files:**
- Modify: `apps/control-plane/src/db/schema.ts`
- Create: `apps/control-plane/drizzle/0004_m4_roles_assets_gate.sql`
- Create: `apps/control-plane/src/services/asset-service.ts`
- Modify: `apps/control-plane/src/db/seed.ts` (sample assets)
- Create: `apps/control-plane/src/routes/assets.ts`
- Modify: `apps/control-plane/src/index.ts`
- Test: `apps/control-plane/tests/assets.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `workspaceId`, Drizzle `db`
- Produces:
  ```ts
  // schema tables: tools, models, knowledgeBases
  createTool(ws, input, role): Promise<Tool>
  listTools(ws, role): Promise<Tool[]>  // filter allowed_roles
  getTool(ws, id): Promise<Tool>
  updateTool(ws, id, patch, role): Promise<Tool>
  deleteTool(ws, id, role): Promise<void>
  // same for models / knowledgeBases (models/KBs: no allowed_roles; write developer+)
  ```

- [ ] **Step 1: Write failing assets route test**

```ts
it("developer can create and list a tool; builder cannot create", async () => {
  const createBuilder = await app.request("/assets/tools", {
    method: "POST",
    headers: { "X-User-Id": "u_builder", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "t1", kind: "function", config: {} }),
  });
  expect(createBuilder.status).toBe(403);

  const createDev = await app.request("/assets/tools", {
    method: "POST",
    headers: { "X-User-Id": "u_dev", "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "t1",
      kind: "function",
      config: { secret_ref: "env:DEMO" },
      allowed_roles: ["builder", "developer", "admin"],
    }),
  });
  expect(createDev.status).toBe(201);
  const list = await app.request("/assets/tools", {
    headers: { "X-User-Id": "u_builder" },
  });
  expect(list.status).toBe(200);
  const tools = (await list.json()) as { name: string }[];
  expect(tools.some((t) => t.name === "t1")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL (404 route or table missing)**

Run: `pnpm --filter @awo/control-plane exec vitest run tests/assets.test.ts`

- [ ] **Step 3: Add schema + SQL migration**

```ts
export const tools = pgTable("tools", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  configJson: jsonb("config_json").notNull(),
  allowedRoles: jsonb("allowed_roles").notNull(), // string[]
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("tools_workspace_name").on(t.workspaceId, t.name)]);

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  configJson: jsonb("config_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("models_workspace_name").on(t.workspaceId, t.name)]);

export const knowledgeBases = pgTable("knowledge_bases", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  configJson: jsonb("config_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("knowledge_bases_workspace_name").on(t.workspaceId, t.name)]);
```

SQL file `0004_m4_roles_assets_gate.sql` must create the three tables + uniques. Register schema in `db/client` relations if used.

- [ ] **Step 4: Implement `asset-service.ts` + `routes/assets.ts`**

- POST/PATCH validate with Zod; `requireRole(role, "developer")` on writes
- `listTools`: `requireRole` not needed beyond auth; filter `allowedRoles` with `roleAtLeast` membership in array (caller role string ∈ allowed_roles OR allowed_roles empty)
- Mount `app.route("/", assetsRoutes)` in `index.ts` after auth

- [ ] **Step 5: Seed demo assets** (`tool_demo_echo`, `model_demo_stub`, `kb_demo`)

- [ ] **Step 6: Run assets tests — PASS; apply migration in test setup**

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/db apps/control-plane/drizzle/0004_m4_roles_assets_gate.sql \
  apps/control-plane/src/services/asset-service.ts apps/control-plane/src/routes/assets.ts \
  apps/control-plane/src/index.ts apps/control-plane/tests/assets.test.ts
git commit -m "feat(m4): tools/models/knowledge_bases registry CRUD"
```

---

### Task 3: Mutating API role guards + draft test-run

**Files:**
- Modify: `apps/control-plane/src/services/flow-service.ts` (`createFlow`, `saveDraft`, `publishFlow` entry — role param)
- Modify: `apps/control-plane/src/services/run-service.ts`
- Modify: `apps/control-plane/src/routes/flow-versions.ts`, `routes/flows.ts`, `routes/runs.ts`
- Test: extend `apps/control-plane/tests/flows.test.ts` + `tests/runs.test.ts`

**Interfaces:**
- Consumes: `requireRole`, draft/published versions
- Produces:
  ```ts
  createFlow(..., role: string)  // requireRole(role, "builder")
  saveDraft(..., role: string)
  // createTestRun(flowId, input, userId, workspaceId, role, graphSource: "published" | "draft")
  ```

- [ ] **Step 1: Failing tests**

```ts
it("viewer cannot save draft", async () => {
  const res = await app.request(`/flows/${flowId}/draft`, {
    method: "PUT",
    headers: { "X-User-Id": "u_viewer", "Content-Type": "application/json" },
    body: JSON.stringify(minimalGraph),
  });
  expect(res.status).toBe(403);
});

it("developer can create draft test-run; builder cannot", async () => {
  const asBuilder = await app.request(`/flows/${flowId}/runs`, {
    method: "POST",
    headers: { "X-User-Id": "u_builder", "Content-Type": "application/json" },
    body: JSON.stringify({ input: {}, graph_source: "draft" }),
  });
  expect(asBuilder.status).toBe(403);

  const asDev = await app.request(`/flows/${flowId}/runs`, {
    method: "POST",
    headers: { "X-User-Id": "u_dev", "Content-Type": "application/json" },
    body: JSON.stringify({ input: {}, graph_source: "draft" }),
  });
  expect(asDev.status).toBe(201);
});
```

- [ ] **Step 2: Run — expect FAIL (viewer still 200 / draft source ignored)**

- [ ] **Step 3: Implement guards**

- At start of `createFlow` / `saveDraft`: `requireRole(role, "builder")`
- `publishFlow(..., role)`: `requireRole(role, "builder")` (gate itself in Task 4)
- In `createTestRun`:
  ```ts
  requireRole(role, "builder");
  const source = graphSource ?? "published";
  if (source === "draft") {
    requireRole(role, "developer");
    // use flow.latestDraftVersionId; must be status draft
  } else {
    // existing published path
  }
  ```
- Pass `c.get("role")` from routes; parse `graph_source` from body

- [ ] **Step 4: Signal/cancel/breakpoints routes: `requireRole(role, "builder")`**

- [ ] **Step 5: Tests PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(m4): enforce role guards and developer draft test-runs"
```

---

### Task 4: Publish gate service + wire into publishFlow

**Files:**
- Create: `apps/control-plane/src/services/publish-gate.ts`
- Create: `apps/control-plane/src/services/publish-gate.test.ts` (unit with mocks or DB)
- Modify: `apps/control-plane/src/services/flow-service.ts` (`publishFlow`)
- Modify: `apps/control-plane/src/routes/flow-versions.ts` (map gate error body)
- Test: `apps/control-plane/tests/publish-gate.test.ts`

**Interfaces:**
- Consumes: draft graph, `hashGraph`, `nodeDefs`, assets tables, `runs`+`flowVersions`, publisher `role`
- Produces:
  ```ts
  export type GateCheck = { id: string; ok: boolean; message?: string };
  export type GateResult = { ok: boolean; checks: GateCheck[] };

  export async function evaluatePublishGate(args: {
    workspaceId: string;
    flowId: string;
    draftGraph: FlowGraph;
    draftSchemaHash: string;
    publisherRole: string;
    publishedVersionId: string | null;
  }): Promise<GateResult>;

  // publishFlow throws httpError with status 400 and
  // (err as any).body = { error: "publish_gate_failed", checks }
  ```

- [ ] **Step 1: Write failing gate unit tests**

```ts
describe("evaluatePublishGate", () => {
  it("fails required_config when HTTP node missing url", async () => {
    const result = await evaluatePublishGate({
      workspaceId: "ws_demo",
      flowId: "flow_x",
      draftGraph: {
        id: "fv",
        state_schema: { type: "object", properties: {} },
        nodes: [
          { id: "n1", type: "HTTP", config: {}, ui: { x: 0, y: 0 } },
          { id: "n2", type: "End", config: {}, ui: { x: 1, y: 0 } },
        ],
        edges: [],
      },
      draftSchemaHash: "deadbeef",
      publisherRole: "builder",
      publishedVersionId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "required_config")?.ok).toBe(false);
  });

  it("skips successful_test_run on bootstrap", async () => {
    const result = await evaluatePublishGate({
      /* minimal Start→End graph with valid config */,
      publishedVersionId: null,
      publisherRole: "builder",
      ...
    });
    const tr = result.checks.find((c) => c.id === "successful_test_run");
    expect(tr?.ok).toBe(true);
    expect(tr?.message).toMatch(/bootstrap/i);
  });
});
```

- [ ] **Step 2: Run — FAIL module missing**

- [ ] **Step 3: Implement `evaluatePublishGate`**

Pseudo-logic:

```ts
const checks: GateCheck[] = [];

// required_config
const defs = await loadNodeDefs(workspaceId);
const configProblems: string[] = [];
for (const node of draftGraph.nodes) {
  const def = defs.find((d) => d.typeKey === node.type);
  if (!def) { configProblems.push(`unknown type ${node.type}`); continue; }
  const required = (def.configSchema as { required?: string[] })?.required ?? [];
  for (const key of required) {
    const v = node.config?.[key];
    if (v == null || v === "") configProblems.push(`node ${node.id}: missing config.${key}`);
  }
  // type extras + asset existence (Tool/LLM/KnowledgeRetrieve)
}
checks.push({
  id: "required_config",
  ok: configProblems.length === 0,
  message: configProblems[0],
});

// successful_test_run
if (publishedVersionId == null) {
  checks.push({ id: "successful_test_run", ok: true, message: "bootstrap_skip" });
} else {
  const hit = await findSucceededTestRunWithHash(flowId, draftSchemaHash);
  checks.push({
    id: "successful_test_run",
    ok: Boolean(hit),
    message: hit ? undefined : `no succeeded test run for hash ${draftSchemaHash}`,
  });
}

// role_nodes
const roleProblems: string[] = [];
for (const node of draftGraph.nodes) {
  const def = defs.find((d) => d.typeKey === node.type);
  if (!def || !roleAtLeast(publisherRole, def.minRole)) {
    roleProblems.push(`node ${node.id}: type ${node.type} requires ${def?.minRole ?? "?"}`);
  }
}
checks.push({ id: "role_nodes", ok: roleProblems.length === 0, message: roleProblems[0] });

return { ok: checks.every((c) => c.ok), checks };
```

- [ ] **Step 4: Wire `publishFlow`**

Before inserting published version:

```ts
const schemaHash = hashGraph(graphWithIdCandidate); // or hash draft graph same as save
const gate = await evaluatePublishGate({...});
if (!gate.ok) {
  const err = new Error("publish_gate_failed");
  (err as any).status = 400;
  (err as any).body = { error: "publish_gate_failed", checks: gate.checks };
  throw err;
}
```

Route mapper:

```ts
catch (e) {
  if ((e as any).body) return c.json((e as any).body, 400);
  ...
}
```

- [ ] **Step 5: HTTP test — missing url → 400 with checks; bootstrap Start/End → 200**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(m4): publish gate required_config, test-run, role_nodes"
```

---

### Task 5: M4 integration test + `test:m4` script

**Files:**
- Create: `apps/control-plane/tests/m4-integration.test.ts`
- Modify: root `package.json` (`test:m4`)

**Interfaces:**
- Consumes: live app + DB + (optional) executor for draft test-run success path
- Produces: green `pnpm test:m4`

- [ ] **Step 1: Write integration scenarios**

```ts
describe("m4 integration", () => {
  it("builder node-defs hide Code; viewer cannot publish", async () => { /* ... */ });

  it("publish fails required_config then succeeds on bootstrap graph", async () => { /* ... */ });

  it("after publish, changed draft blocked without matching test-run; developer draft run unlocks", async () => {
    // 1) bootstrap publish Start→End
    // 2) save draft with Transform change (new hash)
    // 3) publish as builder → 400 successful_test_run
    // 4) draft test-run as u_dev (may need executor; if executor off, insert succeeded run row with matching hash in test harness OR skip live executor with documented DATABASE fixture)
    // 5) publish → 200
  });

  it("asset CRUD developer vs builder", async () => { /* ... */ });
});
```

For step 4 without flaking: prefer **calling real createTestRun + executor** like `m3-integration` when `EXECUTOR_URL` up; else allow test helper `insertSucceededRunForHash` only behind `process.env.M4_GATE_FIXTURE=1` — default path should use real executor when available (mirror `test:m3` env).

- [ ] **Step 2: Add script**

```json
"test:m4": "DATABASE_URL=${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo} EXECUTOR_TOKEN=${EXECUTOR_TOKEN:-test-executor-token-m4} pnpm --filter @awo/control-plane exec vitest run tests/m4-integration.test.ts"
```

- [ ] **Step 3: Run `pnpm test:m4` — PASS; also smoke `pnpm test:m3` still PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "test(m4): integration coverage for roles, assets, publish gate"
```

---

### Task 6: Web — user switcher, palette, assets panel, gate errors

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`
- Create: `apps/web/src/auth/UserSwitcher.tsx`
- Create: `apps/web/src/assets/AssetsPanel.tsx`
- Create: `apps/web/src/canvas/NodePalette.tsx`
- Modify: `apps/web/src/App.tsx`
- Optional: `apps/web/src/styles/m4.css` imported from App

**Interfaces:**
- Consumes: `listNodeDefs`, assets endpoints, publish error body
- Produces: UI wired; `createRun(flowId, input, { graphSource?: "draft" | "published" })`

- [ ] **Step 1: Failing client test for gate error parsing / assets list**

```ts
it("publish throws with checks when gate fails", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        error: "publish_gate_failed",
        checks: [{ id: "required_config", ok: false, message: "missing url" }],
      }),
      { status: 400 },
    );
  const client = createApiClient({ fetchImpl, userId: "u_builder" });
  await expect(client.publish("flow_1")).rejects.toMatchObject({
    status: 400,
    body: { error: "publish_gate_failed" },
  });
});
```

Ensure `request()` attaches `status` + parsed `body` on errors (extend if needed).

- [ ] **Step 2: Implement client methods**

```ts
listTools(): Promise<Tool[]>
createTool(body): Promise<Tool>
deleteTool(id): Promise<void>
// models + knowledgeBases analogs
createRun(flowId, input, opts?: { graphSource?: "draft" | "published" })
```

- [ ] **Step 3: UserSwitcher** — select `u_dev|u_builder|u_viewer|u_admin`; persist to `localStorage`; reload client

- [ ] **Step 4: NodePalette** — `useEffect` load defs; buttons drag/add by `typeKey` (integrate with existing canvas add API in App/FlowCanvas; if canvas only loads samples today, at minimum show filtered list and disable unknown adds)

- [ ] **Step 5: AssetsPanel** — tables + create name form for developer role (detect via optional `GET` that returns 403 on write probe, or pass role from switcher map)

- [ ] **Step 6: App publish handler** — on failure show `checks.map(c => c.message).join("; ")`

- [ ] **Step 7: Run web vitest — PASS**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(m4): web user switcher, palette filter, assets panel, gate errors"
```

---

### Task 7: Docs + design status links

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md` (Status → approved)
- Modify: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (Status line += M4 paths)

- [ ] **Step 1: README M4 section**

Document: roles, seeded users, assets endpoints, publish gate checks, draft test-run, `pnpm test:m4`.

- [ ] **Step 2: Flip M4 design status to approved; ensure parent Status links design+plan**

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: M4 README acceptance and design status links"
```

---

## Self-review (plan vs design)

| Spec section | Task coverage |
|---|---|
| §3 Roles / rank / capabilities | Task 1 (helper+filter+seed), Task 3 (mutate guards) |
| §3.3 Code/Breakpoint min_role | Task 1 seed |
| §3.4 Seed users | Task 1 |
| §4 Asset tables + APIs | Task 2 |
| §4.3 Seed samples | Task 2 |
| §5 Publish gate checks | Task 4 |
| §5.3 Draft test-run | Task 3 |
| §6 Enforcement points | Tasks 1–4 |
| §7 Web UI | Task 6 |
| §8 Migration `0004_…` + `test:m4` | Tasks 2, 5 |
| §9 Acceptance | Task 5 integration |
| YAGNI (no OIDC/vault/multi-approver) | Global Constraints; no tasks add them |

Placeholder scan: no TBD/TODO steps; commands and example tests inlined.
Type consistency: `graph_source` / `GateCheck` / `requireRole` names aligned across tasks.
