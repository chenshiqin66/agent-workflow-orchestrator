# M5 子流程 + 模板 + 轻量指标 实现计划

> **面向代理执行者：** 必用子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤用复选框（`- [ ]`）跟踪。

**目标：** 增加 Subflow 节点：派发时展开已发布的子图；工作区流程模板支持克隆为草稿；从 `runs` 聚合轻量成功/延迟/成本指标。

**架构：** 控制面负责 Subflow 展开（`expandSubflows`），Python 执行器无需改动。模板为新表 `flow_templates` 加 CRUD/克隆路由。指标是对现有 run 列的只读 SQL 聚合 — 无汇总表、无 WS、无 CRDT。

**技术栈：** 沿用 M1–M4 技术栈 — TypeScript、pnpm、Hono、Drizzle、PostgreSQL、Vite、React、XYFlow、Vitest、Zod。路径使用 `apps/control-plane`（不是 `apps/api`）。执行器：无需 Subflow 相关的 Python 改动。

**规格：** `docs/superpowers/specs/2026-10-22-m5-subflow-templates-metrics-design.md`

## 全局约束

- 产品：编排画布 + 运行时调试 — M5 仅交付 **子流程 + 模板 + 轻量指标**
- 鉴权：桩 `X-User-Id` + `memberships.role`；执行器回调 `X-Executor-Token` 不变
- 角色精确为：`admin | developer | builder | viewer`，等级 3/2/1/0（复用 `roleAtLeast` / `requireRole`）
- Subflow 钉住 **`flow_version_id`**（仅已发布）；不支持始终最新的 `flow_id` 引用
- 展开最大深度 **3**；用 version id 展开栈做环检测
- 展平后的子节点/边 id：`` `${subflowNodeId}__${childId}` ``
- 迁移名必须精确：`0005_m5_templates_metrics`
- 不要改动 M3 暂停/信号/checkpoint 行为（带前缀的 id 必须继续可用）
- 不要削弱 M4 发布门禁；只 **新增** 检查项 `subflow_refs`
- 无 CRDT 协作；无完整可观测套件；无 WS 推送
- 指标：仅从 `runs` 聚合；不新建指标表

**后续（不要实现）：** CRDT；WS；告警产品；模板市场；Subflow 输入/输出映射；嵌套 run 行

---

## 关键架构决策（M5 已锁定）

| 决策 | 选择 | 理由 |
|---|---|---|
| Subflow 执行 | 在控制面展开为扁平 `JobPayload.graph` | 执行器不变；M3 时间线/断点仍可用 |
| Subflow 引用 | `config.flow_version_id` 已发布且同工作区 | 可复现运行；符合 M1 不可变 |
| 跨 Subflow 状态 | 完整状态继承（无映射） | YAGNI |
| 模板 | 快照表 + 克隆 → 新 flow/草稿 | builder 路径，不改动源 |
| 指标 | 读取时 SQL 聚合 | 轻量 v1；无数仓 |
| 执行器改动 | 无需 | 扁平图已可执行 |

---

## 文件地图（M5 创建/修改）

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

### 任务 1：`expandSubflows` 库 + 单元测试

**文件：**
- 创建：`apps/control-plane/src/services/subflow-expand.ts`
- 创建：`apps/control-plane/src/services/subflow-expand.test.ts`

**接口：**
- 消费：`FlowGraph` from `@awo/graph-schema`
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

- [ ] **步骤 1：编写会失败的测试**

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

- [ ] **步骤 2：运行 — 预期失败（模块缺失）**

Run: `pnpm --filter @awo/control-plane exec vitest run src/services/subflow-expand.test.ts`
预期：失败（找不到模块）

- [ ] **步骤 3：实现 `subflow-expand.ts`**

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

（仔细实现：过滤仍引用已移除 Subflow id 的边；不要保留占位 Subflow 节点。）

- [ ] **步骤 4：重跑测试 — 通过**

- [ ] **步骤 5：提交**

```bash
git add apps/control-plane/src/services/subflow-expand.ts \
  apps/control-plane/src/services/subflow-expand.test.ts
git commit -m "feat(m5): expandSubflows flattens published child graphs"
```

---

### 任务 2：迁移 `0005_m5_templates_metrics` + 种子 Subflow + 样例模板

**文件：**
- 修改：`apps/control-plane/src/db/schema.ts`
- 创建：`apps/control-plane/drizzle/0005_m5_templates_metrics.sql`
- 修改：`apps/control-plane/src/db/seed.ts`
- 若仓库使用 `drizzle-kit` journal，更新 drizzle meta（对齐 `drizzle/meta` 的 M4 模式）

**接口：**
- 产出 Drizzle 表 `flowTemplates`，以及 `Subflow` node_def + 至少一行 `flow_templates` 种子

- [ ] **步骤 1：添加 schema**

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

- [ ] **步骤 2：SQL 迁移**

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

- [ ] **步骤 3：种子数据**

- 向 `NODE_TYPES` / `UI_META`（紫色、nest 图标）/ category `control` / `min_role: builder` 添加 `Subflow`
- `configSchemaFor("Subflow")` → `{ type: "object", required: ["flow_version_id"], properties: { flow_version_id: { type: "string" } } }`
- 为 `ws_demo` 插入模板 `tpl_demo_basic`（Start→Transform→End 图）
- 集成推荐（可选）：确保存在已发布子流程（在种子中创建 **或** 留给集成测试脚手架）

- [ ] **步骤 4：本地应用迁移**

运行：按需 `pnpm db:up`，再按 M4 同样方式应用 SQL（项目现有 migrate 脚本 / `psql` / drizzle push）。确认表已存在。

- [ ] **步骤 5：提交**

```bash
git add apps/control-plane/src/db/schema.ts apps/control-plane/src/db/seed.ts \
  apps/control-plane/drizzle/0005_m5_templates_metrics.sql apps/control-plane/drizzle/meta
git commit -m "feat(m5): flow_templates table, Subflow node_def, demo template seed"
```

---

### 任务 3：模板服务 + 路由 + 克隆

**文件：**
- 创建：`apps/control-plane/src/services/template-service.ts`
- 创建：`apps/control-plane/src/routes/templates.ts`
- 创建：`apps/control-plane/tests/templates.test.ts`
- 修改：`apps/control-plane/src/index.ts` (mount)

**接口：**
- 消费：`flowTemplates`, `flows`, `flowVersions`, `projects`, `requireRole`, `hashGraph`, `newId`
- Produces:
  ```ts
  listTemplates(workspaceId: string)
  getTemplate(id, workspaceId)
  createTemplateFromPublished(workspaceId, userId, role, { name, description?, flow_version_id })
  deleteTemplate(id, workspaceId, role)
  cloneTemplate(id, workspaceId, userId, role, { project_id, name })
  // → { id: flowId, name }
  ```

- [ ] **步骤 1：会失败的 HTTP 测试**

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

- [ ] **步骤 2：实现 service**

`createTemplateFromPublished`:

1. `requireRole(role, "developer")`
2. 按 id 加载 `flow_versions`；要求 `status === "published"`
3. 校验 flow→project→workspace 匹配
4. 插入 `flow_templates`，拷贝 `graphJson`

`cloneTemplate`:

1. `requireRole(role, "builder")`
2. 在工作区加载模板
3. 事务形态同 `createFlow`，但 `graphJson = { ...template.graphJson, id: newVersionId }` 且 `schemaHash = hashGraph(...)`

- [ ] **步骤 3：路由**

```ts
// GET/POST /templates, GET/DELETE /templates/:id, POST /templates/:id/clone
```

Zod-validate bodies.

- [ ] **步骤 4：跑测试 — 通过**

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(m5): template CRUD and clone-to-draft flow"
```

---

### 任务 4：把展开接入 run 派发 + 发布门禁 `subflow_refs`

**文件：**
- 修改：`apps/control-plane/src/services/run-service.ts`
- 修改：`apps/control-plane/src/services/publish-gate.ts`
- 修改：`apps/control-plane/src/services/publish-gate.test.ts`
- 修改：仅当 job 构建在此文件时改 `apps/control-plane/src/services/executor-client.ts` — 在选定 job `graph` 处 **展开一次**

**接口：**
- 消费：`expandSubflows`、已发布版本的 DB 查找 + 工作区校验
- 产出：JobPayload.graph 始终无 Subflow；门禁检查 `{ id: "subflow_refs", ok, message? }`

- [ ] **步骤 1：解析辅助函数**

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

- [ ] **步骤 2：在创建/派发路径中展开**

加载版本图（已发布或草稿）之后、`dispatchJob` 之前：

```ts
const flat = await expandSubflows(graph, {
  resolvePublished: (id) => resolvePublishedForWorkspace(id, workspaceId),
});
// send flat in JobPayload; persist run still points at parent flow_version_id
```

Map `SubflowExpandError` → HTTP 400 with `{ error: err.code, details: err.details }`.

- [ ] **步骤 3：门禁检查**

在 `evaluatePublishGate` 现有检查之后：

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

当 Subflow 缺少 `flow_version_id` 时也让 `required_config` 失败（种子 schema 已要求）。

- [ ] **步骤 4：门禁单元测试**

- 草稿带错误 `flow_version_id` → `subflow_refs` ok=false
- 草稿带合法已发布子流程 → ok=true

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(m5): expand Subflow on dispatch; publish gate subflow_refs"
```

---

### 任务 5：指标服务 + 路由

**文件：**
- 创建：`apps/control-plane/src/services/metrics-service.ts`
- 创建：`apps/control-plane/src/services/metrics-service.test.ts`
- 创建：`apps/control-plane/src/routes/metrics.ts`
- 创建：`apps/control-plane/tests/metrics.test.ts`
- 修改：`apps/control-plane/src/index.ts`

**接口：**
- Produces:
  ```ts
  getFlowMetrics(flowId, workspaceId, { from?: Date; to?: Date; trigger?: string })
  getWorkspaceMetrics(workspaceId, { from?: Date; to?: Date; trigger?: string })
  ```

- [ ] **步骤 1：带 fixture 计算的会失败单元测试**

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

导出纯函数 `aggregateRunRows` 供无 DB 单元测试。

- [ ] **步骤 2：实现 SQL 查询 + 聚合**

- Completed = 状态属于 `succeeded|failed|cancelled`
- `success_rate = succeeded / completed`（completed=0 则为 0）
- `in_flight` = 状态属于 `queued|running|paused|cancel_requested` 的计数
- Group `by_version` on `flow_version_id`

- [ ] **步骤 3：路由**

`GET /metrics/flows/:flowId` 与 `GET /metrics/workspace` — 鉴权之外无需 `requireRole`；任意 membership 即 viewer+。flow 不在工作区则 404。

- [ ] **步骤 4：HTTP 测试** — 插入/使用现有 runs；断言 JSON 键存在

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(m5): thin flow/workspace metrics from runs"
```

---

### 任务 6：M5 集成测试 + `test:m5` 脚本

**文件：**
- 创建：`apps/control-plane/tests/m5-integration.test.ts`
- 修改：root `package.json` (`test:m5`)

**接口：**
- 消费：真实 app + DB + 执行器（与 `test:m3` / `test:m4` 相同模式）
- 产出：green `pnpm test:m5`

- [ ] **步骤 1：场景**

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

- [ ] **步骤 2：添加脚本**

```json
"test:m5": "DATABASE_URL=${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo} EXECUTOR_TOKEN=${EXECUTOR_TOKEN:-test-executor-token-m5} pnpm --filter @awo/control-plane exec vitest run tests/m5-integration.test.ts"
```

- [ ] **步骤 3：运行 `pnpm test:m5` — 通过；冒烟 `pnpm test:m4` 仍通过**

- [ ] **步骤 4：提交**

```bash
git commit -m "test(m5): integration for subflow expand, templates, metrics"
```

---

### 任务 7：Web — 模板面板、指标面板、M5 样例 + 文档

**文件：**
- 修改：`apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`
- 创建：`apps/web/src/templates/TemplatesPanel.tsx`
- 创建：`apps/web/src/metrics/MetricsPanel.tsx`
- 创建：`apps/web/src/sample-m5-graph.ts`（带 Subflow 占位注释/说明的父图；或发布辅助后从 status 加载子 version id）
- 修改：`apps/web/src/App.tsx`
- Optional: `apps/web/src/styles/m5.css`
- 修改：`README.md`
- 修改：`docs/superpowers/specs/2026-10-22-m5-subflow-templates-metrics-design.md`（Status → approved）
- 修改：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`（Status += M5 路径 — 若写本计划时尚未更新）

**接口：**
- Client:
  ```ts
  listTemplates(): Promise<TemplateSummary[]>
  createTemplate(body: { name: string; description?: string; flow_version_id: string })
  cloneTemplate(id: string, body: { project_id: string; name: string }): Promise<{ id: string; name: string }>
  getFlowMetrics(flowId: string, q?: { from?: string; to?: string }): Promise<FlowMetrics>
  getWorkspaceMetrics(q?: { from?: string; to?: string }): Promise<WorkspaceMetrics>
  ```

- [ ] **步骤 1：客户端测试** listTemplates / getFlowMetrics 解析

- [ ] **步骤 2：TemplatesPanel** — 列出名称；按钮「从模板创建」用 `PROJECT_ID` + 名称提示/默认调用 clone；`onCloned(flowId)` 回调到 App 加载器

- [ ] **步骤 3：MetricsPanel** — 有 `flowId` 时，点「刷新指标」拉取；显示 success_rate、avg_latency_ms、sum_cost_tokens

- [ ] **步骤 4：App** — 挂载面板；加「加载 M5 样例」，说明 Subflow 配置需要已发布 `flow_version_id`（样例可用空 Subflow + 状态提示，或 UI 文案里两步创建）

- [ ] **步骤 5：README M5 节** — Subflow 展开、模板端点、指标、`pnpm test:m5`

- [ ] **步骤 6：设计状态链接** — M5 设计 Status 为 approved；父规格 Status 列出 M5 design+plan

- [ ] **步骤 7：Web vitest 通过；提交**

```bash
git commit -m "feat(m5): web templates/metrics panels and README"
```

---

## 自检（计划 vs 设计）

| 规格章节 | 任务覆盖 |
|---|---|
| §3 Subflow 配置 + 展开 | 任务 1 |
| §3.2 maxDepth/环/前缀 | 任务 1 |
| §3.3 发布门禁 `subflow_refs` | 任务 4 |
| §3.4 角色 | 任务 3–4（现有 requireRole） |
| §4 模板表/API/克隆 | 任务 2–3 |
| §4.3 Seed | Task 2 |
| §5 Metrics API | Task 5 |
| §6 Web UI | Task 7 |
| §7 验收 | 任务 6 集成 |
| YAGNI（无 CRDT/WS/数仓） | 全局约束；无任务添加它们 |
| 执行器不变 | 已锁定决策；无执行器任务 |

占位符扫描：无 TBD/TODO 步骤；命令与示例测试已内联。
类型一致性：`flow_version_id`、`ExpandErrorCode`、`subflow_refs`、`flow_templates`、指标字段名跨任务对齐。
