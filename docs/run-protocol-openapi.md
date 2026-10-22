# Run Protocol — OpenAPI 示意（M2 + M3）

M2/M3 新增的 HTTP 面示意。不是机器生成的 OpenAPI 文件；形态与 `@awo/run-protocol` 以及线上 Hono/FastAPI 处理器一致。

**本地端口：** 控制面 `8787`，执行器 `8790`，web `5173`。

**鉴权：**

| 调用方 | Header | 密钥 |
|---|---|---|
| Web / 用户 API | `X-User-Id`（占位） | seed 的 `u_dev` |
| 控制面 → 执行器 | `X-Executor-Token` | `EXECUTOR_TOKEN` |
| 执行器 → 控制面回调 | `X-Executor-Token` | 同一 `EXECUTOR_TOKEN` |

共享类型在 `packages/run-protocol`（`RunStatus`、`RunEventType`、`Checkpoint`、`JobPayload`、`CallbackEventBody`、`SignalKind`）。

---

## 控制面 — 面向用户的 run API

基址：`http://127.0.0.1:8787`。Header：`X-User-Id: u_dev`。

### `POST /flows/{flowId}/test-runs`

针对 flow 的**已发布**版本创建试运行，并向执行器派发任务。

**请求**

```json
{ "input": { "amount": 42 } }
```

`input` 必须是 JSON 对象（必填）。

**响应**

| 状态码 | Body |
|---|---|
| `201` | `{ "id", "status", "flowVersionId" }` — `status` 通常为 `"queued"`；若派发失败也可能已是 `"failed"` |
| `400` | 无已发布版本、body 非法等 |
| `404` | flow 不在该 workspace |

仅已发布版本可运行（草稿试运行延后）。新 run 的活动断点初始为空；创建后（或续跑前）用 `PUT /runs/{id}/breakpoints` 设置。

### `GET /flows/{flowId}/runs`

列出某 flow 的近期 run（最新优先，默认 limit 20）。

**响应 `200`：** `{ id, flowVersionId, trigger, status, createdAt, startedAt, finishedAt }` 的数组。

### `GET /runs/{runId}`

**响应 `200`：**

```json
{
  "id": "run_…",
  "flowVersionId": "fv_…",
  "trigger": "test",
  "status": "paused",
  "inputJson": {},
  "outputJson": null,
  "errorMessage": null,
  "startedAt": "…",
  "finishedAt": null,
  "costTokens": null,
  "createdBy": "u_dev",
  "createdAt": "…",
  "pauseReason": "breakpoint",
  "checkpoint": {
    "node_id": "n_bp",
    "state": { "x": 1 },
    "pause_kind": "breakpoint"
  }
}
```

`status` ∈ `queued | running | paused | succeeded | failed | cancelled | cancel_requested`。

M3 字段（未暂停时可空）：

- `pauseReason` ∈ `breakpoint | approval | input | null`
- `checkpoint` — 见下方 Checkpoint；未暂停 / 未存储时为 `null`

### `GET /runs/{runId}/events?after_seq=0`

轮询时间线。`after_seq` 默认 `0`；返回 `seq > after_seq` 的事件，升序。

**响应 `200`：**

```json
{
  "events": [
    {
      "id": "re_…",
      "runId": "run_…",
      "seq": 1,
      "nodeId": "n_start",
      "eventType": "run_started",
      "payload": {},
      "ts": "…"
    }
  ]
}
```

`eventType` ∈

`run_started | run_finished | node_started | node_finished | node_failed | emit | log | breakpoint_hit | waiting_signal | signal_received | state_patched`

服务端为每个 `run_id` 从 `1` 起分配单调 `seq`（客户端可选 `seq` 会被忽略）。

**暂停事件（M3）：** `breakpoint_hit` 与 `waiting_signal` 必须在 `payload.checkpoint` 下携带合法 `Checkpoint`。控制面将其写入 `runs.checkpoint_json`，按 `checkpoint.pause_kind` 设置 `pause_reason`，并将状态翻为 `paused`。**没有**单独的 `/internal/.../pause` 端点。

暂停 payload 示例：

```json
{
  "event_type": "breakpoint_hit",
  "node_id": "n_transform",
  "payload": {
    "checkpoint": {
      "node_id": "n_transform",
      "state": { "amount": 42 },
      "pause_kind": "breakpoint"
    }
  },
  "ts": "2026-10-22T04:00:00.000Z"
}
```

`waiting_signal` 同样包含 `checkpoint`，`pause_kind` 为 `approval` 或 `input`（旁侧可出现可选 `schema` / 提示字段）。

### `POST /runs/{runId}/cancel`

| 当前状态 | 结果 |
|---|---|
| `queued` / `running` | → `cancel_requested`（M2；执行器中途取消为尽力而为） |
| `paused` | → 立即 `cancelled`，设置 `finishedAt`，**不**重新派发 |

**响应 `200`：** `{ "id", "status" }`（`cancel_requested` 或 `cancelled`）。

### `POST /runs/{runId}/signal`（M3）

仅当 `status === paused`。Body：

```json
{ "kind": "approve" | "reject" | "input" | "resume", "payload": {} }
```

| `kind` | 允许的 `pauseReason` | 效果 |
|---|---|---|
| `resume` | `breakpoint` | 越过已暂停节点继续；带 checkpoint 重新派发 |
| `approve` | `approval` | 设 `resume_edge_kind=success`；重新派发 |
| `reject` | `approval` | 设 `resume_edge_kind=failure`（无 failure 边时执行器回退 `default`）；重新派发 |
| `input` | `input` | 将 `payload` 合并进检查点 state（`pending_input` / state）；重新派发 |

与当前 `pause_reason` 不匹配的 kind → `400`。成功时：追加 `signal_received`，状态设为 `queued`，清除 `pause_reason`，用 `JobPayload.checkpoint`（+ 活动 `breakpoints`）重新派发任务。

**响应 `200`：** run 摘要，含更新后的 `status` / `checkpoint`（实现返回信号处理后的 run 视图）。

### `PATCH /runs/{runId}/state`（M3）

仅 `paused` 时。Body 为全量替换**或**浅合并（不必两者都有；至少一个）：

```json
{ "state": { "amount": 99 } }
```

或

```json
{ "patch": { "amount": 99 } }
```

更新 `checkpoint.state`，追加 `state_patched`。**不会**自动续跑 —— 调用方须再 `POST …/signal`，带 `resume` / `approve` 等。

**响应 `200`：** `{ "id", "status", "pauseReason", "checkpoint", … }`。

### `PUT /runs/{runId}/breakpoints`（M3）

替换本 run 的活动动态断点集合。

```json
{ "node_ids": ["n_transform", "n_end"] }
```

**响应 `200`：** `{ "node_ids": ["n_transform", "n_end"] }`（活动 ids）。

之后每次派发 / 重新派发都会作为 `JobPayload.breakpoints` 带上。

### `GET /runs/{runId}/breakpoints`（M3）

**响应 `200`：** `{ "node_ids": ["n_transform"] }`。

---

## 控制面 — 执行器回调（内部）

基址：`http://127.0.0.1:8787`。Header：`X-Executor-Token: <EXECUTOR_TOKEN>`。  
挂在 `/internal/*` 下，走执行器鉴权中间件。

### `POST /internal/runs/{runId}/events`

**请求（`CallbackEventBody`）**

```json
{
  "event_type": "node_finished",
  "node_id": "n_transform",
  "payload": { "ok": true },
  "ts": "2026-10-21T14:00:00.000Z"
}
```

`seq` 可选（服务端分配）。run 级事件的 `node_id` 可选。

对于 `breakpoint_hit` / `waiting_signal`，`payload.checkpoint` **必填**且须解析为 `Checkpoint`；处理器在插入事件的同一事务中设为 `paused`。

**响应 `201`：** 含已分配 `seq` 的已插入事件。

### `POST /internal/runs/{runId}/status`

**请求**

```json
{
  "status": "succeeded",
  "output": { "result": 1 },
  "error_message": null
}
```

`status` 可为 `running | paused | succeeded | failed | cancelled`（执行器通常在发出暂停事件后结束任务；控制面已从事件设好 `paused`）。终态会设置 `finishedAt`；`paused` 不会。

**响应 `200`：** `{ "id", "status" }`。

---

## 执行器 — 任务接入

基址：`http://127.0.0.1:8790`。Header：`X-Executor-Token: <EXECUTOR_TOKEN>`（或 `Authorization: Bearer …`）。

### `GET /health`

`{ "ok": true }`

### `POST /v1/jobs`

接受 `JobPayload`，立即返回 `202`，在后台线程跑图，再向 `callback_base_url` POST 状态/事件。暂停时发出暂停事件（+ 可选状态）并**结束任务**（不阻塞 worker）。

**请求（`JobPayload`）**

```json
{
  "run_id": "run_…",
  "flow_version_id": "fv_…",
  "graph": { "nodes": [], "edges": [] },
  "input": {},
  "callback_base_url": "http://127.0.0.1:8787",
  "token": "<same as EXECUTOR_TOKEN>",
  "checkpoint": {
    "node_id": "n_bp",
    "state": {},
    "pause_kind": "breakpoint",
    "resume_edge_kind": "success",
    "pending_input": {}
  },
  "breakpoints": ["n_transform"]
}
```

`checkpoint` 与 `breakpoints` 可选（M3）。冷启动省略 `checkpoint`；续跑始终带上已存检查点。

**Checkpoint**

| 字段 | 必填 | 说明 |
|---|---|---|
| `node_id` | 是 | 暂停在 / 进入该节点之前 |
| `state` | 是 | 执行器工作 state |
| `pause_kind` | 是 | `breakpoint \| approval \| input` |
| `resume_edge_kind` | 否 | 控制面在 approve/reject 时设置 |
| `pending_input` | 否 | input 信号时设置/合并 |

**响应**

| 状态码 | 含义 |
|---|---|
| `202` | `{ "accepted": true, "run_id" }` — 已异步开始执行 |
| `400` | 缺字段 / JSON 非法 |
| `401` | header token 或 job `token` 不匹配 |
| `500` | 执行器未设置 `EXECUTOR_TOKEN` |

**M3 节点子集：** `Breakpoint`、`HumanApproval`、`Input`（外加 M2：`Start`、`End`、`Transform`、`Branch`、`Emit`，可选 `LLM` stub）。

### 续跑规则（执行器）

1. **动态断点**（`job.breakpoints`）：在列出的 `node_id` **进入前**暂停（该次进入无 `node_started`）。检查点 `node_id` 为该节点；`pause_kind=breakpoint`。`resume` 时**进入并执行**该节点（进入前暂停不算一次执行）。
2. **`Breakpoint` 节点**：视为进入后暂停（强制暂停的空操作变换）。`resume` 时**跳过再次进入**，沿出边继续。
3. **`HumanApproval`**：发出 `waiting_signal`（`pause_kind=approval`）后退出。带 `resume_edge_kind` 续跑时走对应出边 kind，且不重复审批副作用（`approve` → `success`；`reject` → `failure`，否则 `default`）。
4. **`Input`**：发出 `waiting_signal`（`pause_kind=input`）；续跑时将 `pending_input` / 信号 payload 合并进 state，再沿 default/success 出边继续。
5. 任务保持**无状态**：暂停即结束进程；续跑是一次带 `checkpoint` 的新 `POST /v1/jobs`。

---

## 环境变量（本地）

| 变量 | 进程 | 说明 |
|---|---|---|
| `DATABASE_URL` | control-plane | 例如 `postgres://awo:awo@localhost:5432/awo` |
| `EXECUTOR_URL` | control-plane | 默认 `http://127.0.0.1:8790` |
| `EXECUTOR_TOKEN` | control-plane **与** executor | 必填共享密钥；派发无默认值 |
| `CALLBACK_BASE_URL` | control-plane（写入 job） | 默认 `http://127.0.0.1:8787` |
| `X-User-Id` | HTTP header（web） | 占位鉴权 `u_dev` |

另见 `apps/executor-py/README.md` 与根 `README.md` 的 M2/M3 小节。
