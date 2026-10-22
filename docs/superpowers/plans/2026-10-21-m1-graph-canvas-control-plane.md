# M1 图编排画布 + 控制面 实现计划

> **面向代理执行者：** 必用子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤用复选框（`- [ ]`）跟踪。

**目标：** 交付可运行的 monorepo：用户可创建流程、在带样式的 XYFlow 画布上编辑草稿图、持久化版本，并发布不可变的 `flow_version`。

**架构：** pnpm monorepo，含 `packages/graph-schema`（共享 Zod/JSON Schema）、`apps/control-plane`（Hono + Drizzle + PostgreSQL）与 `apps/web`（Vite + React + XYFlow）。M1 无执行器；发布只冻结 `graph_json`。鉴权为桩（`X-User-Id` + 种子 membership），直到 M4。

**技术栈：** TypeScript 5.x、pnpm workspaces、Vite、React 18、`@xyflow/react`、Hono、Drizzle ORM、PostgreSQL 16、Vitest、Zod。

**规格：** `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`

## 全局约束

- 产品：编排画布 + 运行时调试（运行时执行从 M2 开始，不在 M1）
- 部署形态：前后端分离；M1 只交付 `apps/web` + `apps/control-plane`
- 后续双人设：`admin` | `developer` | `builder` | `viewer` — M1 只种子一个 developer 用户
- 图是语言无关 JSON；密钥不得出现在 `graph_json` 内
- 已发布的 `flow_versions` 不可变；编辑只创建/更新草稿
- UI 风格：浅蓝/白；圆角节点左侧图标；端口圆点；成功边蓝色；失败边红/橙；边标签；决策用菱形（`Branch`）
- 数据库：PostgreSQL
- Monorepo：pnpm
- 鉴权 M1：桩请求头 `X-User-Id`（尚无 OIDC）
- 执行器传输：推迟到 M2（HTTP 回调）

**后续计划（本计划不要实现）：** M2 执行器 + 试跑时间线；M3 断点/信号；M4 角色/资产/发布门禁；M5 子流程/模板/指标。

---

## 文件地图（M1 创建）

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

### 任务 1：Monorepo 脚手架 + Postgres

**文件：**
- 创建：`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `apps/control-plane/package.json`, `apps/web/package.json`, `packages/graph-schema/package.json`
- 测试：`pnpm -r exec tsc --noEmit` 在桩入口文件存在之后

**接口：**
- 消费：无
- 产出：工作区包 `@awo/graph-schema`、`@awo/control-plane`、`@awo/web`；Postgres 在 `localhost:5432`，库 `awo`，用户/密码 `awo`/`awo`

- [ ] **步骤 1：编写根工作区文件**

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

- [ ] **步骤 2：创建包桩代码**

每个包设置 `"type": "module"`、TypeScript，以及最小的 `src/index.ts`（导出常量 `PACKAGE = "name"`）。

`packages/graph-schema/package.json` 名称：`@awo/graph-schema`，scripts：`"test": "vitest run"`。

`apps/control-plane/package.json` 名称：`@awo/control-plane`，依赖：`hono`、`drizzle-orm`、`postgres`、`zod`、`@awo/graph-schema`。

`apps/web/package.json` 名称：`@awo/web`，依赖：`react`、`react-dom`、`@xyflow/react`、`@awo/graph-schema`。

- [ ] **步骤 3：启动 Postgres 并验证**

```bash
cd /workspace/agent-workflow-orchestrator
pnpm install
pnpm db:up
docker compose ps
```

预期：`postgres` 状态为 running，端口 5432。

- [ ] **步骤 4：提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json docker-compose.yml apps packages
git commit -m "chore: scaffold pnpm monorepo and postgres"
```

---

### 任务 2：`@awo/graph-schema` — Zod 图 + 内容哈希

**文件：**
- 创建：`packages/graph-schema/src/graph.ts`, `packages/graph-schema/src/hash.ts`, `packages/graph-schema/src/index.ts`
- 测试：`packages/graph-schema/src/graph.test.ts`

**接口：**
- 消费：无
- Produces:
  - `EdgeKind = "success" | "failure" | "default"`
  - `GraphNode`, `GraphEdge`, `FlowGraph` Zod types
  - `parseFlowGraph(input: unknown): FlowGraph`
  - `hashGraph(graph: FlowGraph): string` （规范化 JSON 的 sha256）

- [ ] **步骤 1：编写会失败的测试**

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

- [ ] **步骤 2：跑测试 — 预期失败**

```bash
pnpm --filter @awo/graph-schema test
```

预期：失败（模块未找到或导出缺失）。

- [ ] **步骤 3：实现 schema + hash**

`graph.ts` — Zod：

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

`hash.ts`：

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

- [ ] **步骤 4：跑测试 — 预期通过**

```bash
pnpm --filter @awo/graph-schema test
```

预期：通过

- [ ] **步骤 5：提交**

```bash
git add packages/graph-schema
git commit -m "feat(graph-schema): add FlowGraph zod schema and content hash"
```

---

### 任务 3：控制面 DB schema + 种子数据

**文件：**
- 创建：`apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/client.ts`, `apps/control-plane/src/db/seed.ts`, `apps/control-plane/drizzle.config.ts`
- 测试：`apps/control-plane/tests/db-seed.test.ts` （连接 Postgres；无 `DATABASE_URL` 则跳过）

**接口：**
- 消费：无
- 产出：与规格 E-R 对齐的 M1 子集 Drizzle 表： `users`, `workspaces`, `memberships`, `projects`, `flows`, `flow_versions`, `node_defs`, `audit_logs`
- 产出种子：用户 `u_dev`、工作区 `ws_demo`、项目 `p_demo`、membership 角色 `developer`、`Start|End|Branch|HTTP|LLM` 的 node_defs

- [ ] **步骤 1：编写会失败的种子测试**

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

- [ ] **步骤 2：跑测试 — 预期失败**

```bash
DATABASE_URL=postgres://awo:awo@localhost:5432/awo pnpm --filter @awo/control-plane test
```

预期：失败（schema/client 缺失）。

- [ ] **步骤 3：实现 Drizzle schema（M1 列）

关键列（TS 用 camelCase，DB 经 Drizzle 用 snake_case）：

- `flows`: `id`, `projectId`, `name`, `latestDraftVersionId` (nullable text), `publishedVersionId` (nullable text)
- `flow_versions`: `id`, `flowId`, `version` (int), `status` (`draft|published|archived`), `graphJson` (jsonb), `schemaHash` (text), `createdBy`, `createdAt`
- `node_defs`: `id`, `workspaceId`, `typeKey`, `category`, `configSchema` (jsonb), `uiMeta` (jsonb), `minRole`

M1 为求速度，外键类字段用文本 id；有时间再补真正外键。

- [ ] **步骤 4：迁移 + 种子数据**

```bash
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed
```

种子数据 `uiMeta` 示例：

```json
{ "Start": { "color": "blue", "icon": "user", "shape": "rounded" },
  "Branch": { "color": "blue", "icon": "scales", "shape": "diamond" },
  "HTTP": { "color": "blue", "icon": "database", "shape": "rounded" },
  "LLM": { "color": "blue", "icon": "bulb", "shape": "rounded" },
  "End": { "color": "green", "icon": "chat", "shape": "rounded" } }
```

- [ ] **步骤 5：跑测试 — 预期通过**

- [ ] **步骤 6：提交**

```bash
git add apps/control-plane
git commit -m "feat(control-plane): add drizzle schema and demo seed"
```

---

### 任务 4：流程 + 草稿版本 API

**文件：**
- 创建：`apps/control-plane/src/middleware/auth.ts`, `apps/control-plane/src/services/flow-service.ts`, `apps/control-plane/src/routes/flows.ts`, `apps/control-plane/src/routes/flow-versions.ts`, `apps/control-plane/src/index.ts`
- 测试：`apps/control-plane/tests/flows.test.ts`

**接口：**
- 消费：`parseFlowGraph`, `hashGraph` 来自 `@awo/graph-schema`
- 产出 HTTP：
  - `POST /projects/:projectId/flows` body `{ name }` → `{ id, name }`
  - `GET /flows/:flowId` → flow + 最新草稿图
  - `PUT /flows/:flowId/draft` body `{ graph }` → 校验、upsert 草稿 `flow_versions`、更新 `latest_draft_version_id`，返回 `{ versionId, schemaHash, version }`
  - `POST /flows/:flowId/publish` → 把草稿拷成新的 `published` 版本，或把当前草稿 **一次性** 标为 published；设置 `published_version_id`；无草稿则拒绝；永不改写已 `published` 的行
  - `GET /node-defs` → 按工作区列出（请求头用户）

鉴权中间件：读取 `X-User-Id`，加载 membership，设置 `c.set("userId", ...)`、`c.set("workspaceId", ...)`。

- [ ] **步骤 1：编写会失败的 API 测试**（使用 Hono `app.request`）

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

- [ ] **步骤 2：运行 — 预期失败**

- [ ] **步骤 3：实现 service + 路由**

发布规则：

1. 加载 flow + `status === "draft"` 的最新草稿版本。
2. 若不存在 → `400`。
3. 把草稿行设为 `published`，**或**插入 `status=published` 的克隆行并递增 `version`；优先 **仅在从未发布过时原地更新**，否则始终从当前草稿 JSON 插入新的已发布快照，并保留新草稿副本。最简单正确做法：
   - Read draft `graph_json`
   - 插入新的 `flow_versions`，`status=published`，`version = max+1`
   - Update `flows.published_version_id`
   - 保留现有草稿行（或向前克隆草稿）
4. 写入 `audit_logs` 行 `flow.publish`。

`PUT draft` 时：`parseFlowGraph`，把 `graph.id` 设为 version id，`schemaHash = hashGraph(graph)`，upsert 草稿。

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(control-plane): flow draft save and immutable publish"
```

---

### 任务 5：画布 UI 基线（样式参考）

**文件：**
- 创建：`apps/web/src/canvas/FlowCanvas.tsx`, `apps/web/src/canvas/nodes/BaseNode.tsx`, `apps/web/src/canvas/nodes/DecisionNode.tsx`, `apps/web/src/canvas/edges/LabeledEdge.tsx`, `apps/web/src/styles/canvas.css`, `apps/web/src/App.tsx`
- 测试：`apps/web/src/canvas/graph-adapter.test.ts` （API 图 ↔ XYFlow 的纯函数映射）

**接口：**
- 消费：来自 `@awo/graph-schema` 的 `FlowGraph` 类型
- Produces:
  - `toXyflow(graph: FlowGraph): { nodes: Node[]; edges: Edge[] }`
  - `fromXyflow(nodes, edges, graphId): FlowGraph`
  - 视觉：蓝色成功边、红色失败边、菱形 `Branch`，标题区可选

- [ ] **步骤 1：编写适配器测试**

```ts
it("round-trips handles and edge kinds", () => {
  const graph = /* same sample as API test */;
  const { nodes, edges } = toXyflow(graph);
  expect(edges.find((e) => e.id === "e1")?.style?.stroke).toBeDefined();
  const back = fromXyflow(nodes, edges, graph.id);
  expect(back.edges.map((e) => e.kind).sort()).toEqual(["default", "failure", "success"]);
});
```

- [ ] **步骤 2：运行 — 预期失败**

- [ ] **步骤 3：实现节点/边的 CSS**

`canvas.css` 设计令牌：

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

`DecisionNode`：CSS 旋转正方形 45° 或 SVG 菱形；角/边端口映射到 `success` / `failure`。

`LabeledEdge`：用 XYFlow `EdgeLabelRenderer` 显示 `data.label`。

- [ ] **步骤 4：跑适配器测试 — 通过**

- [ ] **步骤 5：手工检查**

```bash
pnpm --filter @awo/web dev
```

打开画布，加载与样式参考路径一致的硬编码样例图（用户问题 → 判断 → 成功/失败）。

- [ ] **步骤 6：提交**

```bash
git commit -m "feat(web): XYFlow canvas baseline with success/failure edge styles"
```

---

### 任务 6：把画布接到控制面

**文件：**
- 创建：`apps/web/src/api/client.ts`
- 修改：`apps/web/src/App.tsx`, `apps/web/src/canvas/FlowCanvas.tsx`
- 测试：`apps/web/src/api/client.test.ts` （mock `fetch`）

**接口：**
- 消费：任务 4 的 HTTP API
- 产出：UI 动作 `Load flow`、`Save draft`、`Publish` 带 `X-User-Id: u_dev` 调 API；防抖保存可选（≥300ms），但 M1 必须有显式保存按钮

- [ ] **步骤 1：用 mock fetch 为 saveDraft 编写客户端单元测试**

- [ ] **步骤 2：实现 client + App 接线**

环境变量：`VITE_API_BASE=http://localhost:8787`

CORS：在 Hono 上为该源开启。

- [ ] **步骤 3：端到端冒烟（手动脚本）**

```bash
pnpm db:up
pnpm --filter @awo/control-plane db:seed
pnpm --filter @awo/control-plane dev   # :8787
pnpm --filter @awo/web dev             # :5173
```

检查清单：

1. 创建/打开演示流程
2. 拖入 `Branch`，连接带标签的 success/failure 边
3. 保存草稿 → 刷新 → 图恢复
4. 发布 → `GET` flow → `publishedVersionId` 已设置；再次编辑并保存产生新草稿 hash，不改动已发布行

- [ ] **步骤 4：提交**

```bash
git commit -m "feat(web): wire canvas save/publish to control-plane API"
```

---

### 任务 7：M1 README + 验收清单

**文件：**
- 创建：`README.md`
- 修改：规格状态行注明已有 M1 计划（可选）

- [ ] **步骤 1：编写 README**，含安装命令，以及从任务 6 检查清单复制的 M1 验收标准

- [ ] **步骤 2：提交**

```bash
git commit -m "docs: add M1 README and local run instructions"
```

---

## 规格覆盖（自检）

| 规格项 | 计划任务 |
|---|---|
| 方案 A 控制面 TS | 任务 1、4 |
| 图 JSON schema | 任务 2 |
| flows/versions/node_defs 的 E-R 子集 | 任务 3 |
| 草稿 + 不可变发布 | 任务 4 |
| 画布样式参考 | 任务 5 |
| CRUD + 版本 + 发布（M1） | 任务 4、6 |
| 运行时/执行器/调试 | 超出范围 → M2 计划 |
| 角色/资产/发布门禁 | 超出范围 → M4 计划 |
| 子流程/模板/指标 | 超出范围 → M5 计划 |

## 占位符 / 一致性检查

- 类型统一使用 `FlowGraph`、`kind: success|failure|default`
- 种子与测试中 ID `u_dev`、`p_demo`、`ws_demo` 保持一致
- 无残留 TBD 步骤

---

## 执行交接

本计划批准执行后，选择：

1. **子代理驱动（推荐）** — 每任务新开子代理，任务间做评审
2. **会话内执行** — 在本会话按检查点执行
