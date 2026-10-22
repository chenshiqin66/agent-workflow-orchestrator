# 设计规格：M3 — 断点 / 信号 / 人工审批

- 日期：2026-10-22
- 状态：已批准；计划见 `docs/superpowers/plans/2026-10-22-m3-breakpoint-signal-human-approval.md`
- 上级规格：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`（§11 M3）
- 依赖：M1（图编排画布 + 发布）+ M2（Python 执行器 + 试运行 + 时间线）
- 架构选型：**检查点续跑**（无状态执行器任务）

## 1. 目标

在 M2 之上交付调试/审批闭环：

1. 命中**断点**（或 `Breakpoint` 节点），暂停运行，可选修改 state，再续跑
2. 命中 **`HumanApproval`** / **`Input`**，暂停等待用户**信号**，再沿正确边继续
3. 持久化暂停原因与检查点，使执行器重启后不会丢失进行中的暂停运行

非目标（明确不在 M3 范围）：

- 显式单步 API（`step`）；临时在下一节点设断点即可
- WebSocket 推送（继续用 HTTP 轮询）
- 真实多审批人路由 / SLA / 邮件通知
- M4 角色 / 发布门禁 / 资产注册表
- 超出 M2 `cancel_requested` 轮询语义的、执行器进程中途取消
- 草稿试运行（仍仅已发布版本）

## 2. 方案（检查点续跑）

当执行器需要等待（命中断点、HumanApproval、Input）时：

1. 通过现有回调发出暂停事件（`breakpoint_hit` 或 `waiting_signal`）
2. 在控制面持久化**检查点** `{ node_id, state, pause_kind, pending_ports? }`
3. 将 run 状态设为 `paused` 并**结束当前任务**（不长期占用阻塞中的 worker）

当用户发出信号或续跑时：

1. 控制面校验 run 为 `paused`，记录 `run_signals` / state 补丁
2. 用同一张图 + `checkpoint`（以及更新后的 `breakpoints` / 信号结果）重新派发新任务
3. 执行器从检查点继续，直到结束或再次暂停

理由：语言无关的执行器便于替换；暂停可在执行器重启后存活；契合 M2 的 HTTP push + callback 传输。

已否决的替代方案：

- 进程内挂起/等待：重启即丢，且占用 worker
- 按节点由控制面调度：会重写 M2 执行模型

## 3. 协议扩展（`@awo/run-protocol`）

### 3.1 RunStatus

在现有状态中增加 `paused`：

`queued | running | paused | succeeded | failed | cancelled | cancel_requested`

### 3.2 RunEventType

新增：

- `breakpoint_hit` — payload：`{ node_id, state_snapshot? }`
- `waiting_signal` — payload：`{ node_id, kind: "approval" | "input", schema? }`
- `signal_received` — payload：`{ signal_id, kind, outcome? }`
- `state_patched` — payload：`{ patch | full_state }`

### 3.3 Checkpoint + JobPayload

```ts
Checkpoint = {
  node_id: string;
  state: Record<string, unknown>;
  pause_kind: "breakpoint" | "approval" | "input";
  /** 审批通过/拒绝后：续跑时走哪条出边 kind */
  resume_edge_kind?: "success" | "failure" | "default";
  /** Input 之后：已合并或待续跑时合并的值 */
  pending_input?: Record<string, unknown>;
}

JobPayload += {
  checkpoint?: Checkpoint;
  breakpoints?: string[]; // 进入前要暂停的节点 id
}
```

### 3.4 用户 API（控制面）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/runs/{runId}/signal` | Body：`{ kind: "approve" \| "reject" \| "input" \| "resume", payload?: object }` — 仅 `paused` 时可用 |
| `PATCH` | `/runs/{runId}/state` | Body：`{ state: object }` 全量替换，或 `{ patch: object }` 浅合并 — 仅 `paused`；发出 `state_patched` |
| `PUT` | `/runs/{runId}/breakpoints` | Body：`{ node_ids: string[] }` 为本 run upsert 活动断点 |
| `GET` | `/runs/{runId}/breakpoints` | 列出活动断点 |
| 已有 | `POST /runs/{runId}/cancel` | 允许从 `paused` → `cancelled`（不重新派发） |

信号语义：

- `approve` → 设 `resume_edge_kind=success`，重新派发
- `reject` → `resume_edge_kind=failure`（若无 failure 边则回退 `default`），重新派发
- `input` → 将 `payload` 合并进检查点 state，重新派发
- `resume` → 断点后（及可选 state 补丁）重新派发，越过已暂停节点继续

与当前 `pause_reason` 不匹配的信号 → `400`。

### 3.5 内部回调

复用 M2 事件回调。暂停事件须包含足够信息，供控制面写入 `checkpoint_json`。若事件 payload 已携带检查点，则**不需要**单独的 `POST /internal/runs/{id}/pause`；优先走同一回调路径。

收到暂停事件时：控制面设 `status=paused`，存储检查点与 pause_reason，不得保持 `running`。

## 4. 数据模型

扩展 `runs`：

- `checkpoint_json` 可空
- `pause_reason` 可空枚举/文本：`breakpoint | approval | input`

新表（与上级 E-R 一致）：

| 表 | 字段 |
|---|---|
| `run_breakpoints` | `id`, `run_id`, `node_id`, `active`（run_id+node_id 唯一） |
| `run_signals` | `id`, `run_id`, `kind`（`approval`/`input`/`resume`）, `payload_json`, `status`（`pending`/`consumed`/`rejected`）, `created_at` |

迁移：`0003_m3_pause_signal`（名称在计划中写死）。

## 5. 执行器（Python）

M3 节点处理：

- **`Breakpoint`**：始终以 `pause_kind=breakpoint` 暂停（视为强制暂停的空操作变换）
- **动态断点**：进入 `job.breakpoints` 中任一节点 id 之前，发出 `breakpoint_hit` 并以该节点检查点退出
- **`HumanApproval`**：发出 `waiting_signal` kind=approval；暂停退出；approve/reject 续跑时走 success/failure 边，且不重复执行审批副作用
- **`Input`**：发出 `waiting_signal` kind=input + 节点配置中的可选 JSON schema；续跑时将 input 合并进 state 再继续

续跑规则：

- 若 `checkpoint.pause_kind == breakpoint` 且信号为 `resume`：从已暂停节点**之后**继续（若暂停发生在进入前，则进入一次 —— 动态断点统一选**进入前**暂停；`Breakpoint` 节点计为已进入再暂停，续跑跳过再次进入）
- 选定规则须写进 OpenAPI 示意与测试

保持 AST 安全的 Branch；不做真实 LLM。取消：任务中途若通过现有机制看到取消，按现有方式结束；已暂停的 run 仅在控制面取消。

## 6. Web UI

- 时间线渲染新事件类型
- 当 `status === paused` 时，显示暂停横幅（原因 + 节点 id）与 **SignalPanel**：Approve / Reject / Input 表单 / Resume
- State 编辑器（JSON）仅在暂停时可用；调用 `PATCH …/state`
- 画布节点上切换断点；对活动 run 同步 `PUT …/breakpoints`（可选：把期望断点缓存到下次试运行创建 —— M3 最低要求：仅活动 run）
- 轮询：**不要**在 `paused` 时停止；仅在终态停止（与 M2 错误停止修复一致）
- 样例图：包含 `HumanApproval` + 至少一个断点目标

## 7. 验收标准

1. 试运行命中动态断点 → `paused` → 修改 state → `resume` → 运行成功；时间线出现 `breakpoint_hit`、`state_patched`、`signal_received`
2. 含 `HumanApproval` 的图：Approve 走成功路径；Reject 走失败路径
3. `Input` 节点：提交的值出现在后续节点 state / emit 中
4. 在 `paused` 时取消 → `cancelled`，取消后不再有后续事件
5. 集成测试覆盖 暂停 → 信号 → 续跑，且不挂起 worker
6. 文档：更新 `docs/run-protocol-openapi.md` + README M3 小节；上级设计状态在写出计划后注明 M3 计划

## 8. 规划实现备注

- 先扩展 `@awo/run-protocol`（类型 + 测试），再 DB/API，再执行器，再 web，再文档 —— 与 M2 同款 SDD 风格
- 单步：不在范围；需要时可通过在后继节点设断点实现
- Seq 仍由服务端单调分配（M2）

## 9. 本对话已敲定事项

- 范围：完整 M3（断点 + 信号 + HumanApproval），不做切片
- 续跑模型：检查点重新派发（非进程内等待，非按节点控制面调度）
- 不做分节 UI 微审批；UI 按 §6
- 显式 step API：延后

## 10. 批准

已于 2026-10-22 在对话中讨论。规格已批准；实现计划已写并执行（Tasks 1–7）。
