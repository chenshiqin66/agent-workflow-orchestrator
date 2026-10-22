# M3 断点 / 信号 / 人工审批 实现计划

> **面向代理执行者：** 必用子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤用复选框（`- [ ]`）跟踪。

**目标：** 在 M2 之上交付调试/审批闭环：动态断点与 `Breakpoint` 节点可暂停运行；`HumanApproval` / `Input` 等待用户信号；暂停的运行持久化 checkpoint，并通过重新派发恢复，不占用执行器 worker。

**架构：** Checkpoint 恢复（无状态执行器任务）。暂停时执行器发出 `breakpoint_hit` 或 `waiting_signal`（载荷含 `Checkpoint`），控制面将 `runs.status=paused` 并存储 `checkpoint_json` / `pause_reason`，随后任务结束。用户通过 `signal` / `PATCH state` / `PUT breakpoints` 更新运行；恢复时带着 `checkpoint`（及活跃 `breakpoints`）重新派发同一已发布图。Web 在 `paused` 期间继续 HTTP 轮询，并展示 SignalPanel。无 WebSocket、无显式 step API；仅已发布版本可试跑的规则不变。

**技术栈：** 沿用 M1/M2 技术栈 — TypeScript、pnpm、Hono、Drizzle、PostgreSQL、Vite、React、XYFlow、Vitest、Zod；Python 3.11+ 执行器（`awo_executor`）、pytest。路径使用 `apps/control-plane`（不是 `apps/api`）。

**规格：** `docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md`

## 全局约束

- 产品：编排画布 + 运行时调试 — M3 交付 **断点 + 信号 + HumanApproval/Input**；角色/资产/发布门禁在 M4；子流程/模板/指标在 M5
- 恢复模型：**仅 checkpoint 重新派发**（不是进程内等待，也不是按节点的 CP 调度）
- 部署形态：前后端分离；Runtime 仍是 `apps/executor-py`
- 鉴权：桩 `X-User-Id`；执行器回调 `X-Executor-Token`（环境变量 `EXECUTOR_TOKEN`）— 不变
- 图是语言无关 JSON；密钥不得出现在 `graph_json` 内
- **仅已发布**的 `flow_versions` 可试跑（M2 规则；不要加草稿 dry-run）
- 不要改动 M1 发布不可变规则
- 时间线投递：**HTTP 轮询**（保留；`paused` 时不停；仅终态停止）
- 无显式 `step` API；以后用临时下一节点断点即可
- 无真实多人审批路由 / SLA / 邮件通知
- 无真实 LLM；Branch 仅 AST 安全表达式
- 迁移名必须精确：`0003_m3_pause_signal`
- 动态断点：在进入 `job.breakpoints` 所列节点 id **之前**暂停
- `Breakpoint` 节点：**进入后暂停**；`resume` 时 **跳过再入** 并沿出边继续
- seq 仍由服务端单调分配（M2）
- `paused` 时取消 → 立即 `cancelled`（不重新派发）；不要让无 worker 的暂停运行卡在 `cancel_requested`

**后续计划（本计划不要实现）：** M4 角色/资产/发布门禁；M5 子流程/模板/指标；WS/SSE 推送；显式 step API。

---

## 关键架构决策（M3 已锁定）

| 决策 | 选择 | 理由 |
|---|---|---|
| 恢复 | 持久化 checkpoint；结束任务；带着 `JobPayload.checkpoint` 重新派发 | 规格；可在执行器重启后存活；语言无关 |
| 暂停信号路径 | 暂停事件在载荷中携带 `checkpoint`；内部 `/events` 处理器设为 `paused` | 单一回调路径；无 `/pause` 端点 |
| 暂停后状态 | `paused`（非终态）；`finishedAt` 保持 null | 规格 RunStatus |
| 恢复派发时状态 | 设为 `queued`，然后执行器上报 `running` | 与 M2 创建流程一致 |
| 动态断点 | 在 `node_started` / 执行之前；checkpoint `node_id` = 该节点；`pause_kind=breakpoint` | 规格 |
| Breakpoint 节点 | 作为强制「进入后暂停」的空操作 transform；恢复时跳过再入 | 规格 |
| HumanApproval 恢复 | `approve` → `resume_edge_kind=success`；`reject` → `failure`（回退 `default`）；不要重跑副作用 | 规格 |
| Input 恢复 | 把 `payload` 合并进 checkpoint state（`pending_input` / state）；沿 default/success 出边继续 | 规格 |
| 非法信号 | 若 kind 与 `pause_reason` 不匹配则 `400` | 规格 |
| 断点作用域 | 仅当前活跃运行（`run_breakpoints`）；每次派发/再派发都带上 | 规格 M3 最低要求 |
| 从暂停取消 | 直接 `cancelled` + `finishedAt`；可选追加 `log` | 规格验收 #4 |

---

## 文件地图（M3 创建/修改）

```
agent-workflow-orchestrator/
  package.json                              # + script test:m3
  packages/run-protocol/
    src/run.ts                              # + paused, new events, Checkpoint, JobPayload fields
    src/run.test.ts
    src/index.ts                            # re-exports
  apps/control-plane/
    src/db/schema.ts                        # runs.+checkpoint/pause; run_breakpoints; run_signals
    src/db/seed.ts                          # + HumanApproval, Input, Breakpoint node_defs
    drizzle/0003_m3_pause_signal.sql
    src/services/run-service.ts             # signal, patchState, breakpoints, cancel-from-paused, getRun fields
    src/services/executor-client.ts         # include checkpoint + breakpoints in JobPayload
    src/routes/runs.ts                      # new routes
    src/routes/internal-runs.ts             # pause-on-event; accept status paused
    tests/runs-schema.test.ts               # extend
    tests/runs.test.ts                      # signal/state/breakpoints unit
    tests/executor-callback.test.ts         # pause event → paused
    tests/m3-integration.test.ts            # live executor pause→signal→resume
  apps/executor-py/
    src/awo_executor/engine.py              # breakpoints, checkpoint resume, pause exit
    src/awo_executor/nodes.py               # Breakpoint, HumanApproval, Input (+ NodeResult.pause)
    tests/test_engine.py                    # resume + BP cases
    tests/test_nodes.py                     # new node handlers
    tests/fixtures/m3_approval_graph.json   # optional fixture
  apps/web/
    src/api/client.ts                       # signal, patchRunState, get/putBreakpoints; RunStatus+paused; RunDetail fields
    src/api/runs.test.ts                    # extend
    src/run/useRunPoll.ts                   # ACTIVE includes paused
    src/run/useRunPoll.test.ts
    src/run/SignalPanel.tsx                 # Approve/Reject/Input/Resume
    src/run/StateEditor.tsx                 # JSON edit while paused
    src/run/RunTimeline.tsx                 # new event labels
    src/run/TestRunPanel.tsx                # wire pause UI
    src/run/BreakpointToggle.tsx            # or canvas context menu helper
    src/sample-m3-graph.ts                  # HumanApproval + Breakpoint demo
    src/App.tsx                             # load M3 sample; breakpoint toggles
    src/styles/run.css                      # pause banner
  docs/run-protocol-openapi.md              # M3 paths + resume rules
  README.md                                 # M3 section
  docs/superpowers/specs/2026-10-22-m3-...  # Status → approved + plan path
  docs/superpowers/specs/2026-10-21-...     # Status += M3 plan path
```

---

### 任务 1：`@awo/run-protocol` — paused、事件、Checkpoint、JobPayload

**文件：**
- 修改：`packages/run-protocol/src/run.ts`, `packages/run-protocol/src/index.ts`
- 测试：`packages/run-protocol/src/run.test.ts`

**接口：**
- 消费：现有 `FlowGraphSchema` 导入
- 产出（扩展，保持向后兼容的必填字段）：
  - `RunStatus` += `"paused"`
  - `RunEventType` += `"breakpoint_hit" | "waiting_signal" | "signal_received" | "state_patched"`
  - `PauseKindSchema` = `"breakpoint" | "approval" | "input"`
  - `CheckpointSchema` / `Checkpoint`:
    ```ts
    {
      node_id: string;
      state: Record<string, unknown>;
      pause_kind: "breakpoint" | "approval" | "input";
      resume_edge_kind?: "success" | "failure" | "default";
      pending_input?: Record<string, unknown>;
    }
    ```
  - `JobPayload` += optional `checkpoint?: Checkpoint`, `breakpoints?: string[]`
  - `SignalKindSchema` (API body helper, optional export) = `"approve" | "reject" | "input" | "resume"`
  - 现有 `parseJobPayload` / `parseCallbackEvent` 必须接受暂停事件与带 checkpoint 的 job

- [ ] **步骤 1：编写会失败的测试**

```ts
import { describe, it, expect } from "vitest";
import {
  RunStatusSchema,
  RunEventTypeSchema,
  CheckpointSchema,
  parseJobPayload,
  parseCallbackEvent,
} from "./index";

describe("run-protocol M3", () => {
  it("accepts paused status", () => {
    expect(RunStatusSchema.parse("paused")).toBe("paused");
  });

  it("accepts new event types", () => {
    for (const t of [
      "breakpoint_hit",
      "waiting_signal",
      "signal_received",
      "state_patched",
    ] as const) {
      expect(RunEventTypeSchema.parse(t)).toBe(t);
    }
  });

  it("parses job with checkpoint and breakpoints", () => {
    const job = parseJobPayload({
      run_id: "run_1",
      flow_version_id: "fv_1",
      graph: {
        id: "fv_1",
        state_schema: { type: "object", properties: {} },
        nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
        edges: [],
      },
      input: {},
      callback_base_url: "http://localhost:8787",
      token: "secret",
      breakpoints: ["n_transform"],
      checkpoint: {
        node_id: "n_transform",
        state: { flag: true },
        pause_kind: "breakpoint",
      },
    });
    expect(job.breakpoints).toEqual(["n_transform"]);
    expect(job.checkpoint?.pause_kind).toBe("breakpoint");
  });

  it("parses breakpoint_hit callback with checkpoint payload", () => {
    const ev = parseCallbackEvent({
      event_type: "breakpoint_hit",
      node_id: "n_transform",
      payload: {
        checkpoint: {
          node_id: "n_transform",
          state: { a: 1 },
          pause_kind: "breakpoint",
        },
      },
    });
    expect(ev.event_type).toBe("breakpoint_hit");
    expect(CheckpointSchema.parse(ev.payload.checkpoint).node_id).toBe(
      "n_transform",
    );
  });
});
```

- [ ] **步骤 2：跑测试 — 预期失败**

```bash
pnpm --filter @awo/run-protocol test
```

预期：失败（未知枚举成员 / 缺少 `CheckpointSchema`）。

- [ ] **步骤 3：在 `run.ts` 实现 schema**

```ts
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "cancel_requested",
]);

export const RunEventTypeSchema = z.enum([
  "run_started",
  "run_finished",
  "node_started",
  "node_finished",
  "node_failed",
  "emit",
  "log",
  "breakpoint_hit",
  "waiting_signal",
  "signal_received",
  "state_patched",
]);

export const PauseKindSchema = z.enum(["breakpoint", "approval", "input"]);
export const ResumeEdgeKindSchema = z.enum(["success", "failure", "default"]);

export const CheckpointSchema = z.object({
  node_id: z.string().min(1),
  state: z.record(z.unknown()),
  pause_kind: PauseKindSchema,
  resume_edge_kind: ResumeEdgeKindSchema.optional(),
  pending_input: z.record(z.unknown()).optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const JobPayloadSchema = z.object({
  run_id: z.string().min(1),
  flow_version_id: z.string().min(1),
  graph: FlowGraphSchema,
  input: z.record(z.unknown()),
  callback_base_url: z.string().min(1),
  token: z.string().min(1),
  checkpoint: CheckpointSchema.optional(),
  breakpoints: z.array(z.string().min(1)).optional(),
});

export const SignalKindSchema = z.enum([
  "approve",
  "reject",
  "input",
  "resume",
]);
```

从 `src/index.ts` 再导出新符号。

- [ ] **步骤 4：跑测试 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add packages/run-protocol
git commit -m "feat(run-protocol): add paused status, pause events, and Checkpoint"
```

---

### 任务 2：DB — `0003_m3_pause_signal` + 种子 HumanApproval / Input / Breakpoint

**文件：**
- 修改：`apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/seed.ts`
- 创建：`apps/control-plane/drizzle/0003_m3_pause_signal.sql`（若用 drizzle-kit generate 则更新 `drizzle/meta`；手写 SQL 亦可，需与 `0002_runs.sql` 一致）
- 测试：`apps/control-plane/tests/runs-schema.test.ts` (extend), `apps/control-plane/tests/db-seed.test.ts` if present

**接口：**
- 消费：现有 Drizzle `runs` / `run_events`
- Produces:

`runs` columns added:
- `checkpointJson` → `checkpoint_json` jsonb nullable
- `pauseReason` → `pause_reason` text nullable (`breakpoint` | `approval` | `input`)

`run_breakpoints`:
- `id` text PK
- `runId` text not null
- `nodeId` text not null
- `active` integer 非空默认 1（1=活跃，0=不活跃）— 避免相对 M1/M2 text/int 风格引入新的 boolean 列类型漂移
- unique `(runId, nodeId)`

`run_signals`:
- `id` text PK
- `runId` text not null
- `kind` text 非空（`approval` | `input` | `resume`）— approve/reject 存为 `approval`，结果放在 `payload_json`
- `payloadJson` jsonb not null
- `status` text not null (`pending` | `consumed` | `rejected`)
- `createdAt` timestamptz default now()

Seed `node_defs` for workspace `ws_demo`:
- `HumanApproval` — category `control`，uiMeta 橙色
- `Input` — category `control`，uiMeta 橙/青
- `Breakpoint` — category `debug`，uiMeta 红/橙

SQL sketch (`0003_m3_pause_signal.sql`):

```sql
ALTER TABLE "runs" ADD COLUMN "checkpoint_json" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pause_reason" text;
--> statement-breakpoint
CREATE TABLE "run_breakpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "node_id" text NOT NULL,
  "active" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "run_breakpoints_run_id_node_id_unique" UNIQUE("run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "run_signals" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "kind" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

- [ ] **步骤 1：编写会失败的 schema/种子测试**

```ts
it("runs table exposes checkpoint_json and pause_reason columns in schema export", () => {
  expect(runs.checkpointJson).toBeDefined();
  expect(runs.pauseReason).toBeDefined();
});

it("run_breakpoints and run_signals tables are defined", () => {
  expect(runBreakpoints.runId).toBeDefined();
  expect(runSignals.kind).toBeDefined();
});

it("seed includes HumanApproval, Input, Breakpoint", async () => {
  // after seed against test DB
  const keys = await db.select({ typeKey: nodeDefs.typeKey }).from(nodeDefs);
  const set = new Set(keys.map((k) => k.typeKey));
  expect(set.has("HumanApproval")).toBe(true);
  expect(set.has("Input")).toBe(true);
  expect(set.has("Breakpoint")).toBe(true);
});
```

- [ ] **步骤 2：运行 — 预期失败**

```bash
pnpm --filter @awo/control-plane exec vitest run tests/runs-schema.test.ts tests/db-seed.test.ts
```

- [ ] **步骤 3：添加 Drizzle 表 + 迁移 + 种子条目**

```bash
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed
```

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add apps/control-plane/src/db apps/control-plane/drizzle apps/control-plane/tests
git commit -m "feat(control-plane): M3 pause columns, breakpoints, and signals tables"
```

---

### 任务 3：控制面 — 事件暂停、signal / state / breakpoints、再派发

**文件：**
- 修改：`apps/control-plane/src/services/run-service.ts`, `apps/control-plane/src/services/executor-client.ts`, `apps/control-plane/src/routes/runs.ts`, `apps/control-plane/src/routes/internal-runs.ts`
- 测试：`apps/control-plane/tests/runs.test.ts`, `apps/control-plane/tests/executor-callback.test.ts`

**接口：**
- 消费：任务 1 类型；任务 2 表；现有 `dispatchJob` / `pushJobToExecutor`
- 产出 HTTP（面向用户，`X-User-Id`）：

| 方法 | 路径 | Body / 说明 |
|---|---|---|
| `POST` | `/runs/:runId/signal` | `{ kind: "approve"\|"reject"\|"input"\|"resume", payload?: object }` — 仅 `paused`；发出 `signal_received`；更新 checkpoint；再派发 |
| `PATCH` | `/runs/:runId/state` | `{ state: object }` 全量替换 **或** `{ patch: object }` 浅合并 — 仅 `paused`；更新 `checkpoint_json.state`；发出 `state_patched` |
| `PUT` | `/runs/:runId/breakpoints` | `{ node_ids: string[] }` — upsert 行，所列设 `active=1`，本 run 其余设 `active=0` |
| `GET` | `/runs/:runId/breakpoints` | `{ node_ids: string[] }` active only |
| `POST` | `/runs/:runId/cancel` | allow from `paused` → set `cancelled` + `finishedAt` (not `cancel_requested`) |

`GET /runs/:runId` adds:
- `pauseReason: string | null`
- `checkpoint: Checkpoint | null` (parsed from `checkpoint_json`)

Internal `/internal/runs/:runId/events`:
- After insert, if `event_type` is `breakpoint_hit` or `waiting_signal`:
  - Require `payload.checkpoint` parseable as `Checkpoint`
  - Update run: `status=paused`, `checkpoint_json=checkpoint`, `pause_reason=checkpoint.pause_kind`, clear `finishedAt` if any
- 状态处理器**不要**把 `paused` 当终态；接受 `status: "paused"` 可作为可选双保险（若执行器也会上报）。优先以事件驱动暂停为真相来源。

`pushJobToExecutor(runId)`:
- 加载活跃断点（`active=1`）→ `breakpoints: string[]`
- 若有 `run.checkpointJson` 且状态为 `queued`（恢复路径），带上 `checkpoint`
- 首次创建时 checkpoint 为 null

Signal semantics in `signalRun(...)`:

```ts
// pseudo
assert status === "paused"
const cp = CheckpointSchema.parse(run.checkpointJson)
const reason = run.pauseReason

if (kind === "resume") {
  if (reason !== "breakpoint") throw httpError("resume only valid for breakpoint pause", 400);
  // leave resume_edge_kind unset; executor skips re-entry for Breakpoint node / enters dynamic target
} else if (kind === "approve" || kind === "reject") {
  if (reason !== "approval") throw httpError(...);
  cp.resume_edge_kind = kind === "approve" ? "success" : "failure";
} else if (kind === "input") {
  if (reason !== "input") throw httpError(...);
  const values = payload ?? {};
  cp.state = { ...cp.state, ...values };
  cp.pending_input = values;
} else throw httpError("invalid kind", 400);

insert run_signals { kind: mapKind(kind), payload_json, status: "consumed" }
append event signal_received
update runs: checkpoint_json=cp, status=queued, pause_reason=null (or keep until running)
await dispatchJob(runId)
```

Map DB `run_signals.kind`: `approve|reject` → `approval`; `input` → `input`; `resume` → `resume`.

State patch:

```ts
assert paused
let state = { ...checkpoint.state }
if (body.state) state = body.state
else if (body.patch) state = { ...state, ...body.patch }
else throw 400
checkpoint.state = state
update runs; append state_patched event; do NOT auto-resume
```

Cancel:

```ts
if (status === "paused") {
  update status=cancelled, finishedAt=now, pause_reason=null
  return { id, status: "cancelled" }
}
// else existing queued|running → cancel_requested
```

- [ ] **步骤 1：编写会失败的 API + 回调测试**

```ts
it("pause event sets run to paused and stores checkpoint", async () => {
  // create run (mock dispatch), POST internal event breakpoint_hit with checkpoint
  const res = await app.request(`/internal/runs/${runId}/events`, {
    method: "POST",
    headers: { "X-Executor-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "breakpoint_hit",
      node_id: "n_transform",
      payload: {
        checkpoint: {
          node_id: "n_transform",
          state: { flag: true },
          pause_kind: "breakpoint",
        },
      },
    }),
  });
  expect(res.status).toBe(201);
  const run = await app.request(`/runs/${runId}`, { headers: userHeaders });
  const body = await run.json();
  expect(body.status).toBe("paused");
  expect(body.pauseReason).toBe("breakpoint");
  expect(body.checkpoint.node_id).toBe("n_transform");
});

it("resume after breakpoint re-queues and dispatches", async () => {
  // given paused breakpoint run
  const sig = await app.request(`/runs/${runId}/signal`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ kind: "resume" }),
  });
  expect(sig.status).toBe(200);
  // status queued or running depending on mock dispatch
});

it("rejects approve when pause_reason is breakpoint", async () => {
  const sig = await app.request(`/runs/${runId}/signal`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ kind: "approve" }),
  });
  expect(sig.status).toBe(400);
});

it("PATCH state while paused emits state_patched", async () => {
  const res = await app.request(`/runs/${runId}/state`, {
    method: "PATCH",
    headers: userHeaders,
    body: JSON.stringify({ patch: { debug: 1 } }),
  });
  expect(res.status).toBe(200);
  const ev = await app.request(`/runs/${runId}/events?after_seq=0`, {
    headers: userHeaders,
  });
  const types = (await ev.json()).events.map((e: { eventType: string }) => e.eventType);
  expect(types).toContain("state_patched");
});

it("cancel while paused → cancelled", async () => {
  const res = await app.request(`/runs/${runId}/cancel`, {
    method: "POST",
    headers: userHeaders,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("cancelled");
});
```

- [ ] **步骤 2：运行 — 预期失败**

```bash
pnpm --filter @awo/control-plane exec vitest run tests/runs.test.ts tests/executor-callback.test.ts
```

- [ ] **步骤 3：实现 service 方法、路由、内部暂停处理、executor-client job 字段**

在 `runs.ts` 接线路由（错误映射模式同现有 handler）。从 `run-service.ts` 导出新函数：`signalRun`、`patchRunState`、`putBreakpoints`、`getBreakpoints`；扩展 `getRun`、`cancelRun`。

- [ ] **步骤 4：运行 — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add apps/control-plane/src apps/control-plane/tests
git commit -m "feat(control-plane): pause handling, signal, state patch, breakpoints APIs"
```

---

### 任务 4：Python 执行器 — 断点、Breakpoint / HumanApproval / Input、checkpoint 恢复

**文件：**
- 修改：`apps/executor-py/src/awo_executor/engine.py`, `apps/executor-py/src/awo_executor/nodes.py`
- 测试：`apps/executor-py/tests/test_engine.py`, `apps/executor-py/tests/test_nodes.py`
- Optional fixture: `apps/executor-py/tests/fixtures/m3_approval_graph.json`

**接口：**
- 消费：带可选 `checkpoint`、`breakpoints` 的 JobPayload JSON
- 产出：与 M2 相同的有序回调，暂停时额外：
  1. `breakpoint_hit` 或 `waiting_signal` 事件，带 `payload.checkpoint`（完整 Checkpoint 对象）与 `node_id`
  2. 事件后可选 `post_status(run_id, "paused")`（以控制面事件处理器为准）
  3. **从 `run_job` 返回** — 不要上报 `succeeded`/`failed`

Extend `NodeResult`:

```python
@dataclass
class NodeResult:
    ok: bool
    state: dict[str, Any]
    output: dict[str, Any] = field(default_factory=dict)
    next_node_id: str | None = None
    terminal: bool = False
    pause: bool = False
    pause_kind: str | None = None  # breakpoint | approval | input
    waiting_schema: dict[str, Any] | None = None
    emit_payload: dict[str, Any] | None = None
    error: str | None = None
    error_code: str | None = None
```

Node handlers:
- `execute_breakpoint(config, state)` → `ok=True`, `pause=True`, `pause_kind="breakpoint"`, state unchanged
- `execute_human_approval(config, state)` → `pause=True`, `pause_kind="approval"`
- `execute_input(config, state)` → `pause=True`, `pause_kind="input"`, `waiting_schema=config.get("schema")`

Engine 循环改动：

1. 有 checkpoint 时 **从 checkpoint 开始**：
   - `state = copy.deepcopy(checkpoint["state"])`
   - `current_id = checkpoint["node_id"]`
   - `resuming = True`
   - 仍上报 `running` + `run_started`（或一条表示恢复的 `log` — 为简单保留 `run_started`；时间线可能多条 — M3 可接受；也可在已有事件时跳过重复 `run_started` — **优先：** 总是 `post_status(running)`；发 `log` `{message:"resume", checkpoint_node}` 代替第二次 `run_started`）
2. **进入前**（未处理恢复跳过时）：
   - 若 `current_id in breakpoints` 且并非（正在恢复且该 id 上已做过动态暂停并已应用 signal resume）：发出 `breakpoint_hit`，构建 checkpoint，退出
   - **首次**命中 job：进入前暂停（尚无 `node_started`）
   - 动态断点后 **恢复**：`resuming` 对该 `node_id` 一次性清除进入前检查，然后正常进入
3. **Breakpoint 节点恢复：** 若 `resuming` 且 `pause_kind==breakpoint` 且节点类型为 `Breakpoint`：**不要**再 execute；再入不发事件；设 `current_id = pick_default_next(out_edges)`；清除 `resuming`；继续
4. **审批恢复：** 若 `resuming` 且 `pause_kind==approval`：走边 `resume_edge_kind`（缺 `failure` 则回退 `default`）；清除 resuming；不再为审批发 `node_started`/`finished`
5. **Input 恢复：** 若 `resuming` 且 `pause_kind==input`：合并 `pending_input` 或已合并 state；走 default/success 出边；清除 resuming
6. 正常 execute 后，若 `result.pause`：发出相应事件 + checkpoint（`node_id`、`state=result.state`、`pause_kind`），然后返回

Engine 中的 Checkpoint 构建辅助：

```python
def _checkpoint(node_id: str, state: dict, pause_kind: str, **extra) -> dict:
    cp = {"node_id": node_id, "state": copy.deepcopy(state), "pause_kind": pause_kind}
    cp.update(extra)
    return cp
```

`waiting_signal` payload:

```python
{
  "kind": "approval" | "input",  # mirror pause_kind mapping
  "schema": result.waiting_schema,  # optional
  "checkpoint": cp,
}
```

`breakpoint_hit` payload:

```python
{"checkpoint": cp, "state_snapshot": cp["state"]}
```

- [ ] **步骤 1：编写会失败的 pytest**

```python
def test_dynamic_breakpoint_pauses_before_enter(mock_callbacks):
    job = {
        "run_id": "r1",
        "flow_version_id": "fv",
        "graph": MINIMAL_TRANSFORM_GRAPH,  # start → transform → end
        "input": {"x": 1},
        "breakpoints": ["n_transform"],
        "callback_base_url": "http://example",
        "token": "t",
    }
    run_job(job, mock_callbacks)
    types = [e["event_type"] for e in mock_callbacks.events]
    assert "breakpoint_hit" in types
    assert mock_callbacks.final_status == "paused" or any(
        e["event_type"] == "breakpoint_hit" for e in mock_callbacks.events
    )
    # transform must NOT have node_finished
    finished_nodes = [
        e["node_id"]
        for e in mock_callbacks.events
        if e["event_type"] == "node_finished"
    ]
    assert "n_transform" not in finished_nodes


def test_resume_after_dynamic_breakpoint_enters_node(mock_callbacks):
    job = {
        **BASE,
        "breakpoints": [],
        "checkpoint": {
            "node_id": "n_transform",
            "state": {"x": 1},
            "pause_kind": "breakpoint",
        },
        "input": {"x": 1},
    }
    run_job(job, mock_callbacks)
    assert mock_callbacks.final_status == "succeeded"


def test_human_approval_reject_takes_failure_edge(mock_callbacks):
    job = {
        **APPROVAL_GRAPH_JOB,
        "checkpoint": {
            "node_id": "n_approve",
            "state": {"ok": True},
            "pause_kind": "approval",
            "resume_edge_kind": "failure",
        },
    }
    run_job(job, mock_callbacks)
    # lands on failure End; succeeded with expected output marker
    assert mock_callbacks.final_status == "succeeded"
    assert mock_callbacks.output.get("path") == "rejected"  # set by Transform on failure path
```

同时单测 `execute_breakpoint` / `execute_human_approval` / `execute_input` 返回 `pause=True`。

- [ ] **步骤 2：运行 — 预期失败**

```bash
cd apps/executor-py && python -m pytest tests/test_engine.py tests/test_nodes.py -v
```

- [ ] **步骤 3：实现 nodes + engine 恢复/暂停路径；保持 M2 图绿灯**

重跑完整执行器套件，确保 Start→Transform→Branch→Emit→End 仍通过。

- [ ] **步骤 4：跑 pytest — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add apps/executor-py
git commit -m "feat(executor-py): checkpoint resume, breakpoints, approval and input nodes"
```

---

### 任务 5：集成测试 — 暂停 → patch/signal → 恢复（+ 取消）

**文件：**
- 创建：`apps/control-plane/tests/m3-integration.test.ts`
- 修改：根 `package.json` — 添加 `"test:m3"` 脚本（对齐 `test:m2`）

**接口：**
- 消费：真实 Postgres、Hono app、spawn 的 uvicorn 执行器（从 `tests/m2-integration.test.ts` 克隆 spawn 辅助到 m3-integration）
- 产出验收 §7.1–7.5 的自动化覆盖

`package.json` script:

```json
"test:m3": "DATABASE_URL=${DATABASE_URL:-postgres://awo:awo@localhost:5432/awo} EXECUTOR_TOKEN=${EXECUTOR_TOKEN:-test-executor-token-m3} pnpm --filter @awo/control-plane exec vitest run tests/m3-integration.test.ts"
```

测试内要发布的图：

1. **Breakpoint 图：** Start → Transform(`n_transform`) → Emit → End
2. **审批图：** Start → HumanApproval(`n_approve`) →（success）Transform(设 `path=approved`) → End；（failure）Transform(设 `path=rejected`) → End
3. **Input 图：** Start → Input(`n_input`，schema `{name:string}`) → Emit → End

必需用例（可为独立 `it` 块，共享 `beforeAll` 服务）：

```ts
it("dynamic breakpoint → patch state → resume → succeeded", async () => {
  // publish breakpoint graph; PUT breakpoints { node_ids: ["n_transform"] } after create
  // OR create run then PUT breakpoints then... breakpoints must be set BEFORE first dispatch.
  // So: create flow, publish, createTestRun, but breakpoints on create need to exist first.
  // Approach: createTestRun, immediately the job may race — better:
  // 1) create run with mocked dispatch disabled OR
  // 2) PUT breakpoints endpoint before dispatch by adding optional breakpoints on test-run body — OUT OF SCOPE.
  // Locked approach for M3: 
  //   a) POST test-runs (job may start)
  //   b) For deterministic test: call putBreakpoints THEN use a graph that has a Breakpoint *node*
  //      so no race; additionally test dynamic BP by putting breakpoints while paused is useless.
  // Deterministic dynamic BP: extend createTestRun only in test via direct DB insert of run_breakpoints
  // BEFORE dispatchJob — integration test helper:
  //   insert run row + breakpoints, then dispatchJob(runId) manually.
});
```

**确定性辅助（本任务必需）：** 导出或复制仅测试路径：

1. 像 M2 测试一样插入已发布 flow
2. 对 Breakpoint-**节点** 与 HumanApproval/Input 图正常 `createTestRun`（无竞态）
3. 对 **动态** 断点：在测试用的小 service 辅助里插入 run 之后；或：文档约定 `PUT /runs/:id/breakpoints` 作用于 **下一次** 派发 — 首次派发时，集成测试在调用 `dispatchJob` **之前** 用 drizzle 向 `run_breakpoints` 插入，采用两阶段创建：
   - **仅当已存在**时加可选 body 字段 — M3 **不要**新增 API 字段
   - 改为：集成测试中先手动插入 `queued` run，再 `db.insert(runBreakpoints)`，然后 `dispatchJob`（复制 `createTestRun` 内部逻辑）
   - 更简单可接受做法：**动态断点主测放在 Python 单元测试（任务 4）**；集成测试用图中的 **`Breakpoint` 节点** 做暂停→patch→恢复，并单独用 signal 测 HumanApproval/Input。暂停时仍调用 `PUT /runs/:id/breakpoints` 并断言 GET；可选在暂停时对后续节点设断点再恢复，验证第二段动态断点。

**最低集成断言（必须全部通过）：**

1. 含 `Breakpoint` 节点的图：运行 → `paused` / `pauseReason=breakpoint` → `PATCH state` `{patch:{debug:true}}` → 事件含 `state_patched` → `signal resume` → `succeeded`；事件含 `breakpoint_hit`、`signal_received`
2. HumanApproval：Approve → output/state 走成功路径；新 run Reject → 失败路径
3. Input：`signal input` 带 `{name:"Ada"}` → 后续 Emit/state 含 `name`
4. 暂停时取消 → `cancelled`；取消时间戳之后无 `node_finished`

Poll helper:

```ts
async function waitForStatus(runId: string, want: string | string[], timeoutMs = 15000) {
  const set = new Set(Array.isArray(want) ? want : [want]);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(`/runs/${runId}`, { headers: userHeaders });
    const body = await res.json();
    if (set.has(body.status)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${[...set]}`);
}
```

- [ ] **步骤 1：编写会失败的集成测试文件**

- [ ] **步骤 2：运行 — 预期失败**

```bash
pnpm test:m3
```

- [ ] **步骤 3：修复接线 / 竞态 / token（端口模式同 M2）**

同时重跑 `pnpm test:m2` 确保无回归。

- [ ] **步骤 4：运行 `pnpm test:m3` 与 `pnpm test:m2` — 预期通过**

- [ ] **步骤 5：提交**

```bash
git add apps/control-plane/tests/m3-integration.test.ts package.json
git commit -m "test: M3 pause signal resume integration"
```

---

### 任务 6：Web — SignalPanel、状态编辑器、断点、时间线、轮询、样例

**文件：**
- 创建：`apps/web/src/run/SignalPanel.tsx`, `apps/web/src/run/StateEditor.tsx`, `apps/web/src/sample-m3-graph.ts`
- 修改：`apps/web/src/api/client.ts`, `apps/web/src/api/runs.test.ts`, `apps/web/src/run/useRunPoll.ts`, `apps/web/src/run/useRunPoll.test.ts`, `apps/web/src/run/RunTimeline.tsx`, `apps/web/src/run/TestRunPanel.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles/run.css`, `apps/web/src/canvas/nodes/BaseNode.tsx` (Breakpoint color if missing)

**接口：**
- 消费：任务 3 的 HTTP API
- Produces UI:
  - `ACTIVE_RUN_STATUSES` 包含 `"paused"`，以便继续轮询
  - 暂停横幅：来自 `run.pauseReason` / `run.checkpoint?.node_id` 的原因 + 节点 id
  - `SignalPanel`：`pauseReason==="approval"` 显示 Approve/Reject；`input` 显示输入表单；`breakpoint` 显示 Resume
  - `StateEditor`：JSON 文本框，保存 → `PATCH /runs/:id/state` 带 `{ state: parsed }`（编辑器全量替换）
  - 断点切换：选中某次 run（或最近一次）时，对画布选中节点右键/按钮调用 `putBreakpoints`（切换集合）；高亮活跃断点节点（CSS 类 `awo-node--breakpoint`）
  - Timeline labels for `breakpoint_hit`, `waiting_signal`, `signal_received`, `state_patched`
  - 样例：`SAMPLE_M3_GRAPH` — Start → Transform → Breakpoint → HumanApproval →（success Emit → End）/（failure End）；App 中有加载按钮
  - 客户端 `RunStatus` 类型含 `paused`；`RunDetail` 增加 `pauseReason`、`checkpoint`

Client additions:

```ts
signalRun(runId: string, body: { kind: "approve"|"reject"|"input"|"resume"; payload?: unknown })
patchRunState(runId: string, body: { state?: object; patch?: object })
getBreakpoints(runId: string) // → { node_ids: string[] }
putBreakpoints(runId: string, nodeIds: string[])
```

`useRunPoll` change:

```ts
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "paused",
  "cancel_requested",
]);
```

更新 `useRunPoll.test.ts`，使 `paused` 时轮询保持 `true`。

- [ ] **步骤 1：编写会失败的客户端 + 轮询测试**

```ts
it("createApiClient.signalRun posts kind resume", async () => {
  const calls: string[] = [];
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ id: "run_1", status: "queued" }), {
        status: 200,
      });
    },
  });
  await client.signalRun("run_1", { kind: "resume" });
  expect(calls[0]).toContain("POST");
  expect(calls[0]).toContain("/runs/run_1/signal");
});

it("nextPollingState stays active for paused", () => {
  expect(nextPollingState({ fetchOk: true, status: "paused" })).toBe(true);
});
```

- [ ] **步骤 2：运行 — 预期失败**

```bash
pnpm --filter @awo/web test
```

- [ ] **步骤 3：实现 client、轮询、SignalPanel、StateEditor、时间线、样例、App 接线、CSS**

手工冒烟清单（稍后写入提交说明 / README）：

```bash
pnpm db:up
pnpm --filter @awo/control-plane db:migrate && pnpm --filter @awo/control-plane db:seed
EXECUTOR_TOKEN=dev EXECUTOR_URL=http://127.0.0.1:8790 CALLBACK_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @awo/control-plane dev
cd apps/executor-py && EXECUTOR_TOKEN=dev uvicorn awo_executor.main:app --port 8790
pnpm --filter @awo/web dev
```

1. 加载 M3 样例 → 保存 → 发布 → 试运行
2. 命中 Breakpoint → 横幅 + Resume；编辑 state；继续
3. 命中 HumanApproval → Approve / Reject
4. 时间线显示新事件类型；暂停时轮询不停

- [ ] **步骤 4：跑单元测试 — 通过**

- [ ] **步骤 5：提交**

```bash
git add apps/web
git commit -m "feat(web): signal panel, state editor, breakpoints, M3 sample"
```

---

### 任务 7：文档 — OpenAPI、README、设计状态、父规格状态

**文件：**
- 修改：`docs/run-protocol-openapi.md`, `README.md`
- 修改：`docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md` (Status)
- 修改：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (Status line)

**接口：**
- 消费：任务 3–6 已实现的路由
- 产出：文档化的 M3 表面 + 恢复规则

- [ ] **步骤 1：更新 M3 设计 Status**

```
- Status: approved; plan in `docs/superpowers/plans/2026-10-22-m3-breakpoint-signal-human-approval.md`
```

更新父设计 Status，同时列出 M3 计划路径（保留 M1/M2/M3 设计引用）。

- [ ] **步骤 2：扩展 OpenAPI 草图**

Document:
- `paused` in RunStatus
- 新事件类型 + 暂停事件载荷中的 checkpoint
- `JobPayload.checkpoint` / `breakpoints`
- `POST /runs/{id}/signal`, `PATCH /runs/{id}/state`, `PUT|GET /runs/{id}/breakpoints`
- Cancel from `paused` → `cancelled`
- 恢复规则段落（动态断点进入前；Breakpoint 节点进入后暂停，恢复跳过再入；审批边 kind）

- [ ] **步骤 3：README M3 节**

与规格 §7 对齐的验收清单；注明 `pnpm test:m3`；如何跑样例。

- [ ] **步骤 4：提交**

```bash
git add docs README.md
git commit -m "docs: M3 protocol sketch, README acceptance, design status"
```

---

## 规格覆盖（自检）

| 规格项 | 计划任务 |
|---|---|
| 目标：断点暂停 → patch → 恢复 | 任务 3–6（集成任务 5） |
| HumanApproval / Input 信号 | 任务 3–4、5、6 |
| Checkpoint 恢复（无状态任务） | 任务 1、3、4 |
| RunStatus `paused` | Task 1, 3, 6 |
| Events `breakpoint_hit`, `waiting_signal`, `signal_received`, `state_patched` | Tasks 1, 3, 4, 6 |
| Checkpoint + JobPayload 字段 | 任务 1、3、4 |
| 用户 API signal / state / breakpoints / 从暂停取消 | 任务 3 |
| 非法信号 → 400 | 任务 3 |
| 经事件载荷暂停（无 `/pause`） | 任务 3 |
| `runs.checkpoint_json` / `pause_reason` | Task 2 |
| `run_breakpoints` / `run_signals` | Task 2 |
| Migration `0003_m3_pause_signal` | Task 2 |
| 动态断点进入前 | 任务 4（+ 单元）；任务 5 Breakpoint 节点路径 |
| Breakpoint 节点进入后暂停；恢复跳过再入 | 任务 4 |
| Approve/reject 边；Input 合并 | 任务 3–5 |
| Web SignalPanel / 状态编辑器 / 断点切换 / 暂停轮询 / 样例 | 任务 6 |
| 文档 OpenAPI + README；父规格状态 | 任务 7 |
| 无 step API / 无 WS / 仅已发布 / 无 M4–M5 | 全局约束 |
| seq 服务端单调 | 不变（任务 3 事件） |
| 集成测试不挂起 worker | 任务 5 |

## 占位符 / 一致性检查

- 路径：全文使用 `apps/control-plane`（绝不用 `apps/api`）
- IDs: `u_dev`, `ws_demo`, `p_demo` unchanged
- 端口：控制面 `8787`，web `5173`，执行器 `8790`
- 环境变量：`EXECUTOR_URL`, `EXECUTOR_TOKEN`, `CALLBACK_BASE_URL`, `DATABASE_URL`
- 暂停种类：仅 `breakpoint | approval | input`
- Signal API kinds: `approve | reject | input | resume`
- DB signal kinds: `approval | input | resume`
- 无 TBD/TODO 步骤；首次派发的动态断点竞态通过 Breakpoint 节点集成 + 进入前 Python 单元测试解决
- M3 之后 `test:m2` 必须保持绿灯

## 延伸（明确可选 — 除非进度超前否则跳过）

- 可选在 `POST .../test-runs` body 带 `breakpoints`，避免动态断点集成依赖 DB 辅助
- 暂停当前节点的画布高亮
- 恢复时跳过重复 `run_started`
- SSE timeline push

---

## 执行交接

本计划批准执行后，选择：

1. **子代理驱动（推荐）** — 每任务新开子代理，任务间做评审
2. **会话内执行** — 在本会话按检查点执行

从任务 1 开始。不要从本计划实现 M4+ 项。
