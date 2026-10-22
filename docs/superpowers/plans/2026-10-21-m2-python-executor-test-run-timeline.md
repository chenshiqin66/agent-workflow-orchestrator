# M2 Python 执行器 + 试跑时间线 实现计划

> **面向代理执行者：** 必用子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤用复选框（`- [ ]`）跟踪。

**目标：** 通过 Python 执行器对已发布的 `flow_version` 做试跑，持久化 `runs` / `run_events`，并在 Web UI 展示运行时间线（节点状态、IO 载荷、seq 顺序、耗时）。

**架构：** 控制面（Hono）为**已发布**的 flow version 创建 `runs` 行，向 `apps/executor-py` 推送 HTTP 任务，并接收 HTTP 回调以追加 `run_events`、更新运行状态。Web 通过轮询 run + events 渲染时间线（M2 无 WebSocket）。共享 Zod 类型在 `packages/run-protocol`。图仍是语言无关 JSON；密钥不得出现在 `graph_json` 或执行器任务载荷中（除不透明引用；M2 不要求）。

**技术栈：** 沿用 M1 技术栈（TypeScript、pnpm、Hono、Drizzle、PostgreSQL、Vite、React、XYFlow、Vitest、Zod），外加 Python 3.11+（`httpx` 或标准库 `urllib`、`pytest`）；执行器接收端可用 FastAPI，或普通 `http.server` / Starlette。

**规格：** `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`（M2 = Python 执行器 + 试跑 + run_events 时间线）

## 全局约束

- 产品：编排画布 + 运行时调试 — M2 交付 **试跑 + 时间线**；断点/信号在 M3
- 部署形态：前后端分离；Runtime 为独立服务（`apps/executor-py`）
- 鉴权：桩 `X-User-Id`（不变）；执行器回调用共享密钥头 `X-Executor-Token`（环境变量）
- 图是语言无关 JSON；密钥不得出现在 `graph_json` 内
- **仅已发布**的 `flow_versions` 可试跑（与不可变发布一致）。草稿 dry-run 仅作延伸备注 — 不要实现
- 不要改动 M1 发布不可变规则
- M2 执行器传输：**HTTP 推送任务 + HTTP 回调**（了结开放项；不用 gRPC）
- M2 时间线投递：**HTTP 轮询**（`GET /runs/:id` + `GET /runs/:id/events?after_seq=N`）；WS/SSE 推迟（延伸备注）
- 无真实 LLM API key；若遇到可选 `LLM` 节点则用固定文本桩，否则 M2 演示图避开它
- M2 可执行节点集：`Start`、`End`、`Transform`（SetState 别名）、`Branch`（简单表达式）、`Emit`。未知类型 → 节点失败并带清晰错误事件（或若配置了失败边则跳过 — 为诚实优先硬失败）
- 为 `Transform` 与 `Emit` 种子/扩展 `node_defs`（并保留 Start|End|Branch）
- 双人设 / 角色 / 资产 / 发布门禁 → M4；Subflow/模板/指标 → M5

**后续计划（本计划不要实现）：** M3 断点/信号/人工审批；M4 角色/资产/发布门禁；M5 子流程/模板/指标。

---

## 关键架构决策（M2 已锁定）

| 决策 | 选择 | 理由 |
|---|---|---|
| 传输 | 控制面向执行器 `/v1/jobs` **POST** 任务；执行器向控制面 `/internal/runs/:id/events` 与 `/internal/runs/:id/status` **POST** 事件/状态 | 规格开放项；本地演示最简；无 gRPC 依赖 |
| 服务间鉴权 | `X-Executor-Token` 共享密钥（环境变量 `EXECUTOR_TOKEN`）；内部路由跳过 `X-User-Id` | 对桩友好；不是保险库 |
| 时间线 | 状态为 `queued\|running` 时客户端每 500–1000ms 轮询 | M2 避免 Redis/WS；仍满足用例 8 + 10 |
| 试跑门禁 | 要求 `flow_versions.status === "published"` | 不可变发布叙事 |
| 节点子集 | Start、End、Transform、Branch、Emit（+ 可选 LLM 桩） | 足以演示路径，无需 HTTP/HumanApproval |
| Branch 表达式 | 受限求值：`state.field == value` / 经 `config.expression` 或 `config.path` + 比较做真值路径查找；**禁止**对任意 Python 做 `eval()` | 安全 |
| Transform | `config.assignments: { key: value \| { "$ref": "state.x" } }` 合并进 run state | 最小 SetState |
| Emit | 追加带 `config.message` / 载荷的 `emit` 事件；不改变控制流 | 时间线可见性 |
| 取消 | 可选 `POST /runs/:id/cancel` 将状态设为 `cancel_requested`；执行器在节点间检查 | 锦上添花；快乐路径后再做 |
| 包布局 | `packages/run-protocol`（TS Zod）；`apps/executor-py`（Python，自有 `pyproject.toml`，不是 pnpm 包） | 贴合 monorepo；pnpm 忽略无 `package.json` 的目录 |

---

## 文件地图（M2 创建/修改）

```
agent-workflow-orchestrator/
  package.json                          # add scripts: dev:executor, test:m2
  docker-compose.yml                    # unchanged Postgres; optional comment only
  packages/run-protocol/
    package.json                        # @awo/run-protocol
    src/index.ts
    src/run.ts                          # Zod: RunStatus, RunEventType, JobPayload, CallbackEvent
    src/run.test.ts
  packages/graph-schema/                # unchanged except re-export if needed
  apps/control-plane/
    src/db/schema.ts                    # + runs, run_events
    src/db/seed.ts                      # + Transform, Emit node_defs
    drizzle/0002_runs.sql               # migration
    src/services/run-service.ts
    src/services/executor-client.ts     # HTTP push job
    src/routes/runs.ts                  # user-facing create/list/get/events/cancel
    src/routes/internal-runs.ts         # executor callbacks
    src/middleware/executor-auth.ts
    src/index.ts                        # mount routes; CORS already present
    tests/runs.test.ts
    tests/executor-callback.test.ts
  apps/executor-py/
    pyproject.toml
    README.md
    src/awo_executor/
      __init__.py
      main.py                           # HTTP server: POST /v1/jobs, GET /health
      engine.py                         # walk graph, emit events
      nodes.py                          # Start/End/Transform/Branch/Emit (+ llm_stub)
      expressions.py                    # safe branch expressions
      callback.py                       # POST events/status to control plane
    tests/test_engine.py
    tests/test_nodes.py
    tests/fixtures/minimal_graph.json
  apps/web/
    src/api/client.ts                   # + createTestRun, getRun, listRunEvents
    src/api/runs.test.ts
    src/run/TestRunPanel.tsx
    src/run/RunTimeline.tsx
    src/run/useRunPoll.ts
    src/App.tsx                         # wire panel after publish
    src/styles/run.css
    src/sample-m2-graph.ts              # Start→Transform→Branch→Emit→End
  docs/superpowers/specs/...design.md   # Status line += M2 plan path
  docs/run-protocol-openapi.md          # short OpenAPI sketch (optional companion)
```

---

### 任务 1：`@awo/run-protocol` — Zod run + 事件类型

**文件：**
- 创建：`packages/run-protocol/package.json`, `packages/run-protocol/src/run.ts`, `packages/run-protocol/src/index.ts`, `packages/run-protocol/src/run.test.ts`
- 修改：根 `pnpm-workspace.yaml` 已覆盖 `packages/*`

**接口：**
- 消费：无（独立 Zod）
- Produces:
  - `RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "cancel_requested"`
  - `RunEventType = "run_started" | "run_finished" | "node_started" | "node_finished" | "node_failed" | "emit" | "log"`
  - `JobPayload`: `{ run_id, flow_version_id, graph, input, callback_base_url, token }`
  - `CallbackEventBody`: `{ seq?, node_id?, event_type, payload, ts? }`
  - `parseJobPayload`, `parseCallbackEvent`

- [ ] **步骤 1：编写会失败的测试**

```ts
import { describe, it, expect } from "vitest";
import { parseJobPayload, parseCallbackEvent, RunStatusSchema } from "./index";

describe("run-protocol", () => {
  it("parses a minimal job payload", () => {
    const job = parseJobPayload({
      run_id: "run_1",
      flow_version_id: "fv_1",
      graph: {
        id: "fv_1",
        state_schema: { type: "object", properties: {} },
        nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
        edges: [],
      },
      input: { question: "hello" },
      callback_base_url: "http://localhost:8787",
      token: "secret",
    });
    expect(job.run_id).toBe("run_1");
  });

  it("rejects unknown run status", () => {
    expect(() => RunStatusSchema.parse("flying")).toThrow();
  });

  it("parses callback event", () => {
    const ev = parseCallbackEvent({
      event_type: "node_finished",
      node_id: "s",
      payload: { output: {}, duration_ms: 3 },
    });
    expect(ev.event_type).toBe("node_finished");
  });
});
```

- [ ] **步骤 2：跑测试 — 预期失败**

```bash
pnpm --filter @awo/run-protocol test
```

- [ ] **步骤 3：实现 Zod schema**

图结构可用 `z.record(z.unknown())`，或从 `@awo/graph-schema` 导入 `FlowGraphSchema`（优先依赖 `@awo/graph-schema` 作为单一真相来源）。

- [ ] **步骤 4：跑测试 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add packages/run-protocol
git commit -m "feat(run-protocol): add Zod types for jobs and run events"
```

---

### 任务 2：DB — `runs` + `run_events` + 种子 Transform/Emit

**文件：**
- 修改：`apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/seed.ts`
- 创建：`apps/control-plane/drizzle/0002_runs.sql`（或用 drizzle-kit 生成）
- 测试：extend `apps/control-plane/tests/db-seed.test.ts` or add `tests/runs-schema.test.ts`

**接口：**
- 消费：现有 Drizzle client
- 产出与规格 E-R 对齐的表：

`runs`:
- `id` text PK
- `flowVersionId` text not null
- `trigger` text 非空（`test` | `prod` | `api`）— M2 只用 `test`
- `status` text not null
- `inputJson` jsonb not null
- `outputJson` jsonb nullable
- `errorMessage` text nullable
- `startedAt` timestamptz nullable
- `finishedAt` timestamptz nullable
- `costTokens` integer nullable default 0
- `createdBy` text not null
- `createdAt` timestamptz default now()

`run_events`:
- `id` text PK
- `runId` text not null
- `seq` integer not null
- `nodeId` text nullable
- `eventType` text not null
- `payloadJson` jsonb not null
- `ts` timestamptz not null default now()
- unique `(runId, seq)`

种子：向 `node_defs` 添加 `Transform`、`Emit`（uiMeta 圆角蓝；category `data` / `debug`）。

- [ ] **步骤 1：编写会失败的种子/schema 测试**，断言种子后存在 `Transform` 与 `Emit`；可选在事务中插入 run 行再回滚

- [ ] **步骤 2：运行 — 预期失败**

- [ ] **步骤 3：添加 Drizzle 表 + 迁移 + 种子条目**

```bash
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed
```

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add apps/control-plane/src/db apps/control-plane/drizzle
git commit -m "feat(control-plane): add runs and run_events tables"
```

---

### 任务 3：控制面 run 服务 + 用户 API

**文件：**
- 创建：`apps/control-plane/src/services/run-service.ts`, `apps/control-plane/src/routes/runs.ts`
- 修改：`apps/control-plane/src/index.ts`（挂载路由；必要时在 CORS 允许 `DELETE`/`POST` cancel）
- 测试：`apps/control-plane/tests/runs.test.ts`
- 依赖：`@awo/run-protocol`

**接口：**
- 消费：`flow_versions`（仅已发布），经现有 project/flow 归属模式做工作区鉴权
- 产出 HTTP（面向用户，`X-User-Id`）：
  - `POST /flows/:flowId/test-runs` body `{ input: object }` → 在**已发布**版本上创建 run；返回 `{ id, status, flowVersionId }`；状态从 `queued` 开始
  - `GET /runs/:runId` → run 元数据
  - `GET /flows/:flowId/runs` → 最近 runs（limit 20）
  - `GET /runs/:runId/events?after_seq=0` → 按 `seq` 升序的 `{ events: [...] }`
  - `POST /runs/:runId/cancel` → 可选；若为 `queued|running` 则设为 `cancel_requested`

Rules:
1. 在工作区解析 flow；要求有 `publishedVersionId`
2. 加载已发布 `flow_versions` 行；缺失或非 `published` 则 `400`
3. 插入 `runs`，`trigger=test`、`status=queued`、`inputJson`
4. 审计 `run.test_create`
5. 本任务尚**不要**调用执行器 — 留 `dispatchJob(runId)` 钩子/TODO 由任务 4 调用，以便测试可在无真实执行器时创建 runs（或 mock 客户端）

- [ ] **步骤 1：编写会失败的 API 测试**（Hono `app.request`）

```ts
it("creates test run only against published version", async () => {
  const headers = { "X-User-Id": "u_dev", "Content-Type": "application/json" };
  // assume helper creates flow + draft + publish from M1 patterns
  const res = await app.request(`/flows/${flowId}/test-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { question: "hi" } }),
  });
  expect(res.status).toBe(201);
  const run = await res.json();
  expect(run.status).toBe("queued");

  const events = await app.request(`/runs/${run.id}/events`, { headers });
  expect(events.status).toBe(200);
  expect((await events.json()).events).toEqual([]);
});

it("rejects test run when nothing published", async () => {
  // flow with draft only
  const res = await app.request(`/flows/${draftOnlyFlowId}/test-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: {} }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **步骤 2：运行 — 预期失败**

- [ ] **步骤 3：实现 run-service + 路由**（派发为桩/空操作）

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(control-plane): test-run CRUD and run_events list APIs"
```

---

### 任务 4：执行器推送客户端 + 内部回调路由

**文件：**
- 创建：`apps/control-plane/src/services/executor-client.ts`, `apps/control-plane/src/middleware/executor-auth.ts`, `apps/control-plane/src/routes/internal-runs.ts`
- 修改：`apps/control-plane/src/services/run-service.ts`（插入后调用 `dispatchJob`）、`apps/control-plane/src/index.ts`
- 测试：`apps/control-plane/tests/executor-callback.test.ts`
- 环境变量：`EXECUTOR_URL`（默认 `http://127.0.0.1:8790`）、`EXECUTOR_TOKEN`、`CALLBACK_BASE_URL`（默认 `http://127.0.0.1:8787`）

**接口：**
- 消费：`JobPayload` from `@awo/run-protocol`
- Produces:
  - `dispatchJob(run)` → 向 `${EXECUTOR_URL}/v1/jobs` POST job JSON；网络失败则标记 run `failed` + 错误事件
  - 内部（请求头 `X-Executor-Token`）：
    - `POST /internal/runs/:runId/events` body 回调事件 → 分配下一个 `seq`，插入 `run_events`
    - `POST /internal/runs/:runId/status` body `{ status, output?, error_message? }` → 更新 `runs`；适当设置 `startedAt`/`finishedAt`
  - `/internal/*` 跳过用户 `authMiddleware`；改用 `executorAuthMiddleware`
  - seq 分配：每 run 事务内 `max(seq)+1`（或 `runs` 上计数器 — M2 为简单优先事务内 `max+1`）

- [ ] **步骤 1：编写会失败的回调测试**，伪造 token 被拒；合法 token 追加 seq 1,2,…，状态转换 `queued → running → succeeded`

- [ ] **步骤 2：运行 — 预期失败**

- [ ] **步骤 3：实现中间件、路由、executor-client（fetch）；创建后接入派发**

无真实执行器的单元测试：注入 `executorClient` 或把 `EXECUTOR_URL` 设为 mock；主单元测试直接打回调，并对派发 mock `fetch`。

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(control-plane): HTTP job dispatch and executor callbacks"
```

---

### 任务 5：Python 执行器包 — engine + nodes

**文件：**
- 创建：文件地图中列出的整个 `apps/executor-py/` 树
- 测试：`apps/executor-py/tests/test_engine.py`, `test_nodes.py`
- Fixture 图：Start → Transform（设 `state.ok = true`）→ Branch（`state.ok == true`）→ Emit → End（成功路径）；失败路径 End 可选

**接口：**
- 消费：JobPayload JSON
- 产出：有序回调：
  1. status `running`
  2. `run_started`
  3. 每节点：`node_started` → 工作 → `node_finished` 或 `node_failed`（载荷含 `input` 快照、`output`、`duration_ms`）
  4. `Emit` 还发送 `event_type: "emit"`
  5. 状态 `succeeded` 或 `failed`，带 `output` / `error_message`
- HTTP：`GET /health` → `{ ok: true }`；`POST /v1/jobs` → 立即 `202`，在后台线程/asyncio 任务中执行
- 校验 `Authorization`/`X-Executor-Token` 与 job token 或服务端环境变量一致

Node semantics:

| Type | Behavior |
|---|---|
| `Start` | 把 job `input` 拷入 `state`；output = state |
| `Transform` | 把 `config.assignments` 应用到 state |
| `Branch` | 求值表达式；真则选 `kind=success` 出边，否则 `failure`；缺边则失败 |
| `Emit` | 发出带消息的事件；沿 `default`/`success` 出边 |
| `End` | 标记终态；run output = state |
| `LLM`（可选桩） | 设 `state.llm_text = config.stub_text \|\| "stub"` — 无网络 |
| 其他 | 带 `unsupported_node_type` 的 `node_failed` |

表达式安全（`expressions.py`）：仅允许：
- `state.<ident>` 路径读取
- comparisons `==`, `!=`, `>`, `<`, `>=`, `<=`
- 布尔字面量 / 带括号的 `and`/`or`/`not`
- 拒绝超出 `state` 的属性访问、调用、导入，以及非字符串/整数字面量的下标表达式（按需）

- [ ] **步骤 1：为 fixture 图编写会失败的 pytest 快乐路径**（mock 回调客户端收集事件）

- [ ] **步骤 2：运行 — 预期失败**

```bash
cd apps/executor-py && python -m pytest
```

- [ ] **步骤 3：实现 nodes + engine + 回调客户端 + 主 HTTP 服务**

若已熟悉优先 FastAPI + uvicorn；否则 Starlette 或标准库亦可。在包 README 写明启动命令：

```bash
EXECUTOR_TOKEN=dev CALLBACK_BASE_URL=http://127.0.0.1:8787 \
  uvicorn awo_executor.main:app --port 8790
```

- [ ] **步骤 4：跑 pytest — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add apps/executor-py
git commit -m "feat(executor-py): minimal graph engine and HTTP job server"
```

---

### 任务 6：集成测试 — 控制面 + 执行器快乐路径

**文件：**
- 创建：`apps/control-plane/tests/m2-integration.test.ts` (or `scripts/m2-smoke.sh` + vitest)
- 修改：根 `package.json` scripts `"test:m2": "..."`

**接口：**
- 消费：真实 Postgres、控制面 `app`、执行器进程（spawn 或假定 `EXECUTOR_URL`）
- 产出：一条自动化快乐路径（**无真实 LLM**）

推荐做法（CI 可靠）：
1. 在 `beforeAll` 用 child_process 进程内启动执行器，或用纯 Python pytest POST 到测试替身
2. 优先 **Vitest 集成**，要求：
   - 使用 Hono app + 真实 DB
   - 对执行器出站 `fetch` 做 mock：经 `python -c` **同步调用 Python engine**，或在临时端口启动 uvicorn
3. 若进程 spawn 不稳，最低标准：控制面回调单元测试（任务 4）+ Python engine 测试（任务 5）+ 有文档的手工冒烟；仍需一条按执行器方式驱动回调的集成测试（合成）**以及**一条向 mock HTTP 回调服务器（`http.server`）POST 的 Python 测试

**必需断言路径：**
1. 发布图（Start→Transform→Branch→Emit→End）
2. `POST test-runs`，body `{ input: { flag: true } }`
3. 等到 run `succeeded`（轮询或 await 执行器）
4. 事件含递增 `seq`，每个节点有 `node_finished`，一个 `emit`，最终状态 succeeded
5. `output_json` 反映变换后的 state

- [ ] **步骤 1：编写会失败的集成测试**

- [ ] **步骤 2：运行 — 预期失败**（直到执行器接好）

- [ ] **步骤 3：修复接线 / 不稳定（超时、token 环境变量）**

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git commit -m "test: M2 control-plane + executor happy path"
```

---

### 任务 7：Web — 试跑面板 + 运行时间线

**文件：**
- 创建：`apps/web/src/run/TestRunPanel.tsx`, `RunTimeline.tsx`, `useRunPoll.ts`, `styles/run.css`, `sample-m2-graph.ts`
- 修改：`apps/web/src/api/client.ts`, `apps/web/src/App.tsx`
- 测试：`apps/web/src/api/runs.test.ts`, optional `useRunPoll` pure helper test

**接口：**
- 消费：任务 3 的 HTTP API
- Produces UI:
  - **试跑面板**（侧边或底部）：JSON 输入框（默认 `{"question":"demo"}`），仅当有 `publishedVersionId` 时启用 **试运行** 按钮；显示 run id + 状态徽章
  - **运行时间线**：按 `seq` 列事件；每行显示时间、已知的节点 id/类型、事件类型、载荷耗时、可展开 IO JSON
  - 可选：按最新事件的 `data-status` 高亮 XYFlow 节点（锦上添花；面板提前完成再做）
  - 状态为 `queued|running|cancel_requested` 时每 750ms 轮询；终态停止

`client.ts` additions:

```ts
createTestRun(flowId: string, input: unknown)
getRun(runId: string)
listRunEvents(runId: string, afterSeq?: number)
cancelRun(runId: string) // optional
```

Wire App:
- 发布成功后面板解锁
- 提供按钮把 `sample-m2-graph` 载入画布演示（或替换建流种子）

- [ ] **步骤 1：为 createTestRun / listRunEvents 编写客户端 mock-fetch 测试**

- [ ] **步骤 2：运行 — 预期失败**

- [ ] **步骤 3：实现 client + 面板 + 时间线 + CSS（浅蓝/白，与画布一致）**

- [ ] **步骤 4：跑单元测试 — 通过；手工冒烟：**

```bash
pnpm db:up
pnpm --filter @awo/control-plane db:migrate && pnpm --filter @awo/control-plane db:seed
EXECUTOR_TOKEN=dev EXECUTOR_URL=http://127.0.0.1:8790 CALLBACK_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @awo/control-plane dev
# other terminal:
cd apps/executor-py && EXECUTOR_TOKEN=dev uvicorn awo_executor.main:app --port 8790
pnpm --filter @awo/web dev
```

Checklist:
1. 创建/打开 flow → 粘贴/加载 M2 样例 → 保存 → 发布
2. 用样例输入试运行
3. 时间线按序填充；状态翻转为 succeeded
4. 经轮询刷新事件且无重复行（`after_seq`）

- [ ] **步骤 5：提交**

```bash
git commit -m "feat(web): test run panel and run timeline UI"
```

---

### 任务 8：文档 — OpenAPI 草图、README、规格状态

**文件：**
- 创建：`docs/run-protocol-openapi.md`（草图路径来自任务 3–4 + 执行器 `/v1/jobs`）
- 修改：`README.md`（M2 节：如何跑执行器 + 试跑）
- 修改：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` Status 行包含 M2 计划路径
- 修改：规格 §12 开放项「首个执行器传输」→ M2 定为 HTTP 回调

- [ ] **步骤 1：更新设计规格 Status**

```
- Status: approved; M1 plan in `docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`; M2 plan in `docs/superpowers/plans/2026-10-21-m2-python-executor-test-run-timeline.md`
```

- [ ] **步骤 2：编写 OpenAPI 草图 + README M2 验收清单**

- [ ] **步骤 3：提交**

```bash
git commit -m "docs: M2 run protocol sketch and README acceptance"
```

---

## 规格覆盖（自检）

| 规格项 | 计划任务 |
|---|---|
| M2 Python 执行器 + 试跑 + run_events 时间线 | 任务 1–8 |
| E-R `runs` / `run_events` | 任务 2 |
| Run API 创建 / 取消 | 任务 3 |
| 执行器 HTTP 推送 + 事件回调 | 任务 4–5 |
| 画布触发试运行 + 时间线 | 任务 7 |
| 图 JSON 语言无关 | 不变；任务嵌入已发布图 |
| HTTP vs gRPC 开放项 | 本计划锁定为 HTTP |
| 断点 / 信号 / HumanApproval | 超出范围 → M3 |
| 角色 / 资产 / 发布门禁 | 超出范围 → M4 |
| 子流程 / 模板 / 指标 | 超出范围 → M5 |
| 真实 LLM / 密钥保险库 | 超出范围 |
| 草稿试跑 | 明确推迟（仅延伸） |
| WS 时间线推送 | 推迟；M2 用轮询 |

## 占位符 / 一致性检查

- ID：`u_dev`、`p_demo`、`ws_demo` 不变
- 端口：控制面 `8787`，web `5173`，执行器 `8790`
- 环境变量：`EXECUTOR_URL`、`EXECUTOR_TOKEN`、`CALLBACK_BASE_URL`、`DATABASE_URL`、`X-User-Id`
- 每个 `run_id` 的事件 `seq` 从 1 起单调递增
- 无残留 TBD 步骤；cancel 可选但 API 形态已定
- M2 样例图快乐路径演示不得依赖 HTTP/HumanApproval 节点

## 延伸（明确可选 — 除非进度超前否则跳过）

- SSE 端点 `GET /runs/:id/stream` 作为轮询替代
- 按实时状态高亮画布节点
- 草稿 dry-run：永不标 `trigger=prod`，并盖 `draft_version_id`（仍优先仅已发布）
- 执行器飞行中遵守 `POST /runs/:id/cancel`

---

## 执行交接

本计划批准执行后，选择：

1. **子代理驱动（推荐）** — 每任务新开子代理，任务间做评审
2. **会话内执行** — 在本会话按检查点执行

从任务 1 开始。不要从本计划实现 M3+ 项。
