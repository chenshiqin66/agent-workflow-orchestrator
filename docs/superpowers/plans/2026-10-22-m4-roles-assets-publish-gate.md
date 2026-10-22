# M4 角色 + 资产注册表 + 发布门禁 实现计划

> **面向代理执行者：** 必用子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤用复选框（`- [ ]`）跟踪。

**目标：** 用工作区角色约束节点可见性与写接口；增加最小的 tools/models/knowledge_bases 注册表 CRUD；发布前必须满足必填配置与匹配的成功试跑（首次发布有 bootstrap 例外）。

**架构：** 保留桩鉴权 `X-User-Id` → `memberships.role`。引入 `roleAtLeast` 等级辅助；按 `min_role` 过滤 `GET /node-defs`；用结构化检查门禁 `publishFlow`；放宽试跑允许 developer+ 使用 `graph_source: "draft"`。新增 Drizzle 表与 `/assets/*` 路由。Web：用户切换器、服务端过滤的节点面板、轻量资产面板、发布门禁错误展示。无 OIDC、无密钥保险库、无多人审批流。

**技术栈：** 沿用 M1–M3 技术栈 — TypeScript、pnpm、Hono、Drizzle、PostgreSQL、Vite、React、XYFlow、Vitest、Zod。路径使用 `apps/control-plane`（不是 `apps/api`）。

**规格：** `docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md`

## 全局约束

- 产品：编排画布 + 运行时调试 — M4 交付 **角色 + 资产 + 发布门禁**；子流程/模板/指标在 M5
- 鉴权：仅桩 `X-User-Id`；执行器回调 `X-Executor-Token` 不变
- 角色精确为：`admin | developer | builder | viewer`，等级 3/2/1/0
- 图是语言无关 JSON；密钥不得出现在 `graph_json`（资产 `config_json` 可仅含不透明 `secret_ref` 字符串 — 无保险库）
- 不要改动 M1 发布不可变（新发布行；草稿不动）
- 不要改动 M3 暂停/信号/checkpoint 行为
- 默认试跑仍是 **published**；草稿试跑仅 developer+/admin
- 发布门禁 bootstrap：当 `publishedVersionId` 为 null 时跳过 `successful_test_run`
- 迁移名必须精确：`0004_m4_roles_assets_gate`
- 无 OIDC；无多人审批发布；M4 无 `credentials` 表

**后续计划（本计划不要实现）：** M5 子流程/模板/指标；OIDC；密钥保险库；WS 推送。

---

## 关键架构决策（M4 已锁定）

| 决策 | 选择 | 理由 |
|---|---|---|
| 鉴权 | 保留 `X-User-Id` + memberships | 规格 YAGNI；与 M1–M3 一致 |
| 角色检查辅助 | 经数值等级的 `roleAtLeast(role, min)` | 路由 + 节点过滤 + 门禁共用一个函数 |
| 节点可见性 | 在 `GET /node-defs` 做服务端过滤 | builder 看不到 Code id |
| 草稿试跑 | 创建 run 时 `graph_source: "draft"`；developer+ | 解决发布门禁鸡生蛋问题，无需假发布 |
| 门禁失败形态 | `400` `{ error: "publish_gate_failed", checks: [...] }` | Web 可按检查项渲染 |
| 资产 | 三张表；无 credentials | 父规格 E-R 子集；无保险库 |
| 工具列表 ACL | `allowed_roles` jsonb 字符串数组；空/缺省 = 全部角色 | 最小授权 |
| Code 节点 | 仅种子 `node_defs`；执行器仍可桩/失败 | 先做可见性/治理 |

---

## 文件地图（M4 创建/修改）

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

### 任务 1：角色辅助 + 多种子用户 + 过滤 node-defs

**文件：**
- 创建：`apps/control-plane/src/auth/roles.ts`
- 创建：`apps/control-plane/src/auth/roles.test.ts`
- 修改：`apps/control-plane/src/db/seed.ts`
- 修改：`apps/control-plane/src/services/flow-service.ts` (`listNodeDefs`)
- 修改：`apps/control-plane/src/routes/flows.ts`
- 测试：`apps/control-plane/tests/roles-node-defs.test.ts`

**接口：**
- 消费：`memberships.role`、`nodeDefs.minRole`、现有 `authMiddleware` 变量
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

- [ ] **步骤 1：为 roles 编写会失败的单元测试**

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

- [ ] **步骤 2：跑测试 — 预期失败（模块缺失）**

Run: `pnpm --filter @awo/control-plane exec vitest run src/auth/roles.test.ts`
预期：失败（找不到模块或 parseRole 未定义）

- [ ] **步骤 3：实现 `roles.ts`**

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

- [ ] **步骤 4：重跑 roles 单元测试 — 通过**

- [ ] **步骤 5：更新种子 — 用户 + Code + min_role**

In `seed.ts`:
- Upsert 用户/membership：`u_admin`/`admin`、`u_dev`/`developer`、`u_builder`/`builder`、`u_viewer`/`viewer`
- Add `Code` to `NODE_TYPES` with `UI_META` / category `integration` (or `agent`)
- Per-type `min_role`: default `builder`; `Code` and `Breakpoint` → `developer`
- For `HTTP`, set `configSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } }`

- [ ] **步骤 6：Filter `listNodeDefs(workspaceId, role)`**

```ts
export async function listNodeDefs(workspaceId: string, role: string) {
  const rows = await db.select().from(nodeDefs).where(eq(nodeDefs.workspaceId, workspaceId));
  return rows.filter((d) => roleAtLeast(role, d.minRole));
}
```

Route: `listNodeDefs(c.get("workspaceId"), c.get("role"))`.

- [ ] **步骤 7：HTTP 测试 builder vs developer 的 node-defs**

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

测试 setup 需已应用 DB 种子（与 `flows.test.ts` 相同模式）。

- [ ] **步骤 8：提交**

```bash
git add apps/control-plane/src/auth apps/control-plane/src/db/seed.ts \
  apps/control-plane/src/services/flow-service.ts apps/control-plane/src/routes/flows.ts \
  apps/control-plane/tests/roles-node-defs.test.ts
git commit -m "feat(m4): role ranks, multi-user seed, filter node-defs by min_role"
```

---

### 任务 2：资产表迁移 + asset-service CRUD

**文件：**
- 修改：`apps/control-plane/src/db/schema.ts`
- 创建：`apps/control-plane/drizzle/0004_m4_roles_assets_gate.sql`
- 创建：`apps/control-plane/src/services/asset-service.ts`
- 修改：`apps/control-plane/src/db/seed.ts`（样例资产）
- 创建：`apps/control-plane/src/routes/assets.ts`
- 修改：`apps/control-plane/src/index.ts`
- 测试：`apps/control-plane/tests/assets.test.ts`

**接口：**
- 消费：`requireRole`, `workspaceId`, Drizzle `db`
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

- [ ] **步骤 1：编写会失败的 assets 路由测试**

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

- [ ] **步骤 2：运行 — 预期失败（404 路由或表缺失）**

Run: `pnpm --filter @awo/control-plane exec vitest run tests/assets.test.ts`

- [ ] **步骤 3：添加 schema + SQL 迁移**

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

SQL 文件 `0004_m4_roles_assets_gate.sql` 必须创建三张表及唯一约束。若使用 relations，在 `db/client` 注册 schema。

- [ ] **步骤 4：实现 `asset-service.ts` + `routes/assets.ts`**

- POST/PATCH 用 Zod 校验；写操作 `requireRole(role, "developer")`
- `listTools`：鉴权之外无需 `requireRole`；用调用方角色是否 ∈ allowed_roles（或 allowed_roles 为空）过滤
- 在 `index.ts` 鉴权之后挂载 `app.route("/", assetsRoutes)`

- [ ] **步骤 5：种子演示资产**（`tool_demo_echo`、`model_demo_stub`、`kb_demo`）

- [ ] **步骤 6：跑 assets 测试 — 通过；测试 setup 中应用迁移**

- [ ] **步骤 7：提交**

```bash
git add apps/control-plane/src/db apps/control-plane/drizzle/0004_m4_roles_assets_gate.sql \
  apps/control-plane/src/services/asset-service.ts apps/control-plane/src/routes/assets.ts \
  apps/control-plane/src/index.ts apps/control-plane/tests/assets.test.ts
git commit -m "feat(m4): tools/models/knowledge_bases registry CRUD"
```

---

### 任务 3：写接口角色守卫 + 草稿试跑

**文件：**
- 修改：`apps/control-plane/src/services/flow-service.ts`（`createFlow`、`saveDraft`、`publishFlow` 入口 — role 参数）
- 修改：`apps/control-plane/src/services/run-service.ts`
- 修改：`apps/control-plane/src/routes/flow-versions.ts`, `routes/flows.ts`, `routes/runs.ts`
- 测试：extend `apps/control-plane/tests/flows.test.ts` + `tests/runs.test.ts`

**接口：**
- 消费：`requireRole`、草稿/已发布版本
- Produces:
  ```ts
  createFlow(..., role: string)  // requireRole(role, "builder")
  saveDraft(..., role: string)
  // createTestRun(flowId, input, userId, workspaceId, role, graphSource: "published" | "draft")
  ```

- [ ] **步骤 1：会失败的测试**

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

- [ ] **步骤 2：运行 — 预期失败（viewer 仍 200 / draft source 被忽略）**

- [ ] **步骤 3：实现守卫**

- At start of `createFlow` / `saveDraft`: `requireRole(role, "builder")`
- `publishFlow(..., role)`：`requireRole(role, "builder")`（门禁本身在任务 4）
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
- 从路由传 `c.get("role")`；从 body 解析 `graph_source`

- [ ] **步骤 4：signal/cancel/breakpoints 路由：`requireRole(role, "builder")`**

- [ ] **步骤 5：测试通过**

- [ ] **步骤 6：提交**

```bash
git commit -m "feat(m4): enforce role guards and developer draft test-runs"
```

---

### 任务 4：发布门禁服务 + 接入 publishFlow

**文件：**
- 创建：`apps/control-plane/src/services/publish-gate.ts`
- 创建：`apps/control-plane/src/services/publish-gate.test.ts` (unit with mocks or DB)
- 修改：`apps/control-plane/src/services/flow-service.ts` (`publishFlow`)
- 修改：`apps/control-plane/src/routes/flow-versions.ts` (map gate error body)
- 测试：`apps/control-plane/tests/publish-gate.test.ts`

**接口：**
- 消费：草稿图、`hashGraph`、`nodeDefs`、资产表、`runs`+`flowVersions`、发布者 `role`
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

- [ ] **步骤 1：编写会失败的门禁单元测试**

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

- [ ] **步骤 2：运行 — 失败（模块缺失）**

- [ ] **步骤 3：实现 `evaluatePublishGate`**

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

- [ ] **步骤 4：接入 `publishFlow`**

插入已发布版本之前：

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

- [ ] **步骤 5：HTTP 测试 — 缺 url → 400 带 checks；bootstrap Start/End → 200**

- [ ] **步骤 6：提交**

```bash
git commit -m "feat(m4): publish gate required_config, test-run, role_nodes"
```

---

### 任务 5：M4 集成测试 + `test:m4` 脚本

**文件：**
- 创建：`apps/control-plane/tests/m4-integration.test.ts`
- 修改：root `package.json` (`test:m4`)

**接口：**
- 消费：真实 app + DB +（可选）执行器用于草稿试跑成功路径
- 产出：green `pnpm test:m4`

- [ ] **步骤 1：编写集成场景**

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

步骤 4 避免不稳定：当 `EXECUTOR_URL` 可用时优先像 `m3-integration` 一样 **调用真实 createTestRun + 执行器**；否则仅在 `process.env.M4_GATE_FIXTURE=1` 下允许测试辅助 `insertSucceededRunForHash` — 默认路径在可用时用真实执行器（对齐 `test:m3` 环境）。

- [ ] **步骤 2：添加脚本**

```json
"test:m4": "DATABASE_URL=${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo} EXECUTOR_TOKEN=${EXECUTOR_TOKEN:-test-executor-token-m4} pnpm --filter @awo/control-plane exec vitest run tests/m4-integration.test.ts"
```

- [ ] **步骤 3：运行 `pnpm test:m4` — 通过；并冒烟 `pnpm test:m3` 仍通过**

- [ ] **步骤 4：提交**

```bash
git commit -m "test(m4): integration coverage for roles, assets, publish gate"
```

---

### 任务 6：Web — 用户切换器、节点面板、资产面板、门禁错误

**文件：**
- 修改：`apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`
- 创建：`apps/web/src/auth/UserSwitcher.tsx`
- 创建：`apps/web/src/assets/AssetsPanel.tsx`
- 创建：`apps/web/src/canvas/NodePalette.tsx`
- 修改：`apps/web/src/App.tsx`
- 可选：从 App 导入 `apps/web/src/styles/m4.css`

**接口：**
- 消费：`listNodeDefs`、assets 端点、发布错误 body
- 产出：UI wired; `createRun(flowId, input, { graphSource?: "draft" | "published" })`

- [ ] **步骤 1：门禁错误解析 / 资产列表的会失败客户端测试**

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

确保 `request()` 在错误时附带 `status` + 解析后的 `body`（按需扩展）。

- [ ] **步骤 2：实现客户端方法**

```ts
listTools(): Promise<Tool[]>
createTool(body): Promise<Tool>
deleteTool(id): Promise<void>
// models + knowledgeBases analogs
createRun(flowId, input, opts?: { graphSource?: "draft" | "published" })
```

- [ ] **步骤 3：UserSwitcher** — 选择 `u_dev|u_builder|u_viewer|u_admin`；持久化到 `localStorage`；重载 client

- [ ] **步骤 4：NodePalette** — `useEffect` 加载 defs；按 `typeKey` 拖拽/添加（接入 App/FlowCanvas 现有添加 API；若画布目前只加载样例，至少显示过滤列表并禁用未知添加）

- [ ] **步骤 5：AssetsPanel** — 表格 + developer 角色的创建名称表单（可用可选写探测 `GET` 返回 403 判断，或从切换器映射传 role）

- [ ] **步骤 6：App 发布处理** — 失败时显示 `checks.map(c => c.message).join("; ")`

- [ ] **步骤 7：跑 web vitest — 通过**

- [ ] **步骤 8：提交**

```bash
git commit -m "feat(m4): web user switcher, palette filter, assets panel, gate errors"
```

---

### 任务 7：文档 + 设计状态链接

**文件：**
- 修改：`README.md`
- 修改：`docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md`（Status → approved）
- 修改：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`（Status 行 += M4 路径）

- [ ] **步骤 1：README M4 节**

文档说明：角色、种子用户、assets 端点、发布门禁检查、草稿试跑、`pnpm test:m4`。

- [ ] **步骤 2：把 M4 设计状态改为 approved；确保父规格 Status 链到 design+plan**

- [ ] **步骤 3：提交**

```bash
git commit -m "docs: M4 README acceptance and design status links"
```

---

## 自检（计划 vs 设计）

| 规格章节 | 任务覆盖 |
|---|---|
| §3 角色 / 等级 / 能力 | 任务 1（helper+filter+seed）、任务 3（写守卫） |
| §3.3 Code/Breakpoint min_role | 任务 1 种子 |
| §3.4 种子用户 | 任务 1 |
| §4 资产表 + API | 任务 2 |
| §4.3 种子样例 | 任务 2 |
| §5 发布门禁检查 | 任务 4 |
| §5.3 草稿试跑 | 任务 3 |
| §6 强制点 | 任务 1–4 |
| §7 Web UI | Task 6 |
| §8 Migration `0004_…` + `test:m4` | Tasks 2, 5 |
| §9 验收 | 任务 5 集成 |
| YAGNI（无 OIDC/保险库/多人审批） | 全局约束；无任务添加它们 |

占位符扫描：无 TBD/TODO 步骤；命令与示例测试已内联。
类型一致性：`graph_source` / `GateCheck` / `requireRole` 名称跨任务对齐。
