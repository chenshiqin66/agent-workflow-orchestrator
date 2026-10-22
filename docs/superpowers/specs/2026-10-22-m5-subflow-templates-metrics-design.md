# 设计规格：M5 — 子流程、模板、精简指标

- 日期：2026-10-22
- 状态：已批准；已在 `feature/m5-subflow-templates-metrics` 实现；计划见 `docs/superpowers/plans/2026-10-22-m5-subflow-templates-metrics.md`
- 上级规格：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`（§11 M5；§4.1 Subflow；§5 用例 5–6；§6 可观测性精简 v1）
- 依赖：M1–M4（图发布、执行器运行、暂停/信号、角色 + 发布门禁）
- 架构选型：**控制面在派发前将 Subflow 展开为扁平 JobPayload 图**（执行器对 Subflow 无感）

## 1. 目标

用复用能力与轻量运维可见性收束 v1 产品弧线：

1. **Subflow** — 节点引用**已发布**的 `flow_version`，在父 run 内联（扁平化）执行该图
2. **模板** — 将已发布图快照为 workspace 模板；**克隆**为新草稿 flow（Builder 路径）
3. **精简指标** — 从现有 `runs` 表按 flow / version 聚合成功率、延迟与 token 成本（不引入新可观测栈）

非目标（明确不在 M5 / YAGNI）：

- CRDT 多画布实时协作
- 完整可观测套件（traces、仪表盘、告警产品、APM）
- WebSocket 推送（继续用 HTTP 轮询）
- 嵌套暂停 UX 打磨（超出「子节点以带前缀 id 出现在时间线」）
- 动态「始终最新已发布」Subflow 引用（M5 仅钉死 **`flow_version_id`**）
- 模板市场 / 跨 workspace 共享
- 改变 M3 检查点语义或 M4 角色等级 / 门禁冷启动规则（仅**新增** `subflow_refs` 门禁检查）

## 2. 当前基线（已有能力）

| 领域 | 现状 |
|---|---|
| 节点目录 | `node_defs` / seed 中无 `Subflow`；执行器返回 `unsupported_node_type` |
| 图 schema | `type: string` 自由格式；除 Zod record 外无 Subflow 配置校验 |
| 任务派发 | `run-service` 将父级 `graph_json` 原样发给执行器 |
| 发布门禁 | `required_config`、`successful_test_run`、`role_nodes`（M4） |
| 模板 | 无 |
| 指标 | 已有 `runs.cost_tokens`、`started_at`、`finished_at`、`status`；无聚合 API |
| Web | M2/M3 样例图；资产 + 角色 UI；无模板选择器 / 指标面板 |

## 3. Subflow

### 3.1 节点契约

- **type**：`Subflow`
- **min_role**：`builder`
- **config**（必填）：

```json
{
  "flow_version_id": "fv_xxx"
}
```

规则：

- `flow_version_id` 必须存在、`status = published`，且所属 flow 的 project 与父级在**同一 workspace**
- 自引用（父 flow 自身已发布版本）仅在展开深度/环检测仍通过时允许（子图再指回时通常会被环检测拦住）
- 可选未来键（`input_map`、`output_key`）**不在 M5** —— 子图入口继承完整父 `state`；内联 End 之后带着该 state 继续（等同把子节点拼进父图）

### 3.2 展开（控制面）

在构建 `JobPayload.graph`（试运行或生产派发）之前调用：

```ts
expandSubflows(graph, {
  resolvePublished: (flowVersionId) => Promise<FlowGraph | null>,
  maxDepth?: number // 默认 3
}): Promise<FlowGraph>
```

算法：

1. 遍历节点；对每个 `type === "Subflow"`：
   - 按 `config.flow_version_id` 解析已发布图 `G_child`
   - 递归展开 `G_child`（depth + 1）；若 `depth > maxDepth` 则拒绝 → 错误 `subflow_depth_exceeded`
   - 若 `flow_version_id` 已在**展开栈**上则拒绝 → `subflow_cycle`
   - 给每个子节点/边 id 以及边的 source/target 加前缀 `${subflowNodeId}__`
   - 重连：所有指向 Subflow 节点的入边改指向子图的 **Start** 节点（必须恰好一个 Start）；所有从 Subflow 节点出发的出边改从子图的 **End** 节点出发（必须恰好一个 End）
   - 去掉 Subflow 占位节点；拼入展开后的子节点/边
2. 返回**不再含**任何 `Subflow` 节点的扁平图

相对「执行器原生 Subflow」的理由：

- 执行器不变（保留 M2/M3 路径）
- 子图内时间线 / 断点 / HumanApproval 可用带前缀的 `node_id`
- 已发布不可变：钉死的 `flow_version_id` 契合 M1 版本模型

已否决的替代方案：

- 每个 Subflow 长期嵌套任务（额外 run 行，取消更难）
- 始终最新的 `flow_id` 引用（运行不可复现）

### 3.3 发布门禁新增

新检查 id：**`subflow_refs`**

- 每个草稿 `Subflow` 节点须有非空 `config.flow_version_id`
- 目标版本须已发布且同 workspace
- 以 maxDepth=3 干跑展开必须成功（暴露环/深度/缺 Start/End）

失败形态不变：`400 { error: "publish_gate_failed", checks: [...] }`。

### 3.4 角色

| 动作 | 最低角色 |
|---|---|
| 放置 / 编辑 Subflow 节点 | builder+（经现有草稿保存） |
| 发布含 Subflow 的图 | builder+ + 门禁 |
| 试运行会展开 Subflow 的父图 | 同 M4（已发布 builder+；草稿 developer+） |

## 4. 模板

### 4.1 表

```
flow_templates(
  id text PK,
  workspace_id text not null,
  name text not null,
  description text not null default '',
  graph_json jsonb not null,          -- 快照；克隆时重写 graph.id
  source_flow_version_id text,        -- 可选审计指针
  created_by text not null,
  created_at timestamptz not null default now()
)
unique (workspace_id, name)
```

迁移名写死：**`0005_m5_templates_metrics`**（仅模板表；指标无需 DDL）。

### 4.2 API

基路径 `/templates`（需鉴权）。

| 方法 | 路径 | 最低角色 | 行为 |
|---|---|---|---|
| `GET` | `/templates` | viewer+ | 列出 workspace 模板 `{ id, name, description, createdAt, sourceFlowVersionId }` |
| `GET` | `/templates/:id` | viewer+ | 详情含 `graph` |
| `POST` | `/templates` | developer+ | Body `{ name, description?, flow_version_id }` — 将**已发布**版本的 `graph_json` 拷入新模板 |
| `DELETE` | `/templates/:id` | developer+ | 删除 |
| `POST` | `/templates/:id/clone` | builder+ | Body `{ project_id, name }` — 创建新 flow + 草稿版本；图为模板 `graph_json` 深拷贝，且新 `graph.id` = 新草稿 version id |

克隆沿用与 `createFlow` 相同的插入模式，但草稿图来自模板而非空图。

### 4.3 Seed

- 一个模板 `tpl_demo_ragish`（或类似）含 Start → Transform → End 样例图
- 可选：再 seed 一个可作 Subflow 目标的迷你已发布「库」flow

## 5. 精简指标

### 5.1 数据源

对调用者 workspace 范围内的 `runs` ⋈ `flow_versions` ⋈ `flows` ⋈ `projects` 做只读 SQL。

成功率分母用的终态：`succeeded | failed | cancelled`（完成集合排除 `queued|running|paused|cancel_requested`；可选单独报告 `in_flight` 计数）。

### 5.2 API

| 方法 | 路径 | 最低角色 |
|---|---|---|
| `GET` | `/metrics/flows/:flowId` | viewer+ |
| `GET` | `/metrics/workspace` | viewer+ |

查询参数（两者共用）：

- `from` / `to` — ISO 时间戳（可选；默认最近 7 天，按 Asia/Shanghai 墙钟理解并存为 timestamptz）
- `trigger` — 可选 `test|prod|api` 过滤

响应形态（单 flow）：

```json
{
  "flow_id": "flow_x",
  "from": "...",
  "to": "...",
  "totals": {
    "runs": 12,
    "succeeded": 10,
    "failed": 1,
    "cancelled": 1,
    "in_flight": 0,
    "success_rate": 0.8333,
    "avg_latency_ms": 1520,
    "sum_cost_tokens": 4200,
    "avg_cost_tokens": 350
  },
  "by_version": [
    {
      "flow_version_id": "fv_y",
      "version": 2,
      "status": "published",
      "runs": 5,
      "succeeded": 5,
      "failed": 0,
      "cancelled": 0,
      "success_rate": 1,
      "avg_latency_ms": 900,
      "sum_cost_tokens": 1000,
      "avg_cost_tokens": 200
    }
  ]
}
```

延迟：对同时有两个时间戳的行用 `extract(epoch from (finished_at - started_at)) * 1000`；平均值忽略 null。

Workspace 端点：每 flow 一条 `totals` 的数组（不强制 `by_version` 以保持 payload 精简；含 `flow_id`、`name`）。

M5 不做 Prometheus、告警规则或后台汇总表。

## 6. Web UI（精简）

- **模板**：列表 +「从模板创建」→ 克隆 → 在画布加载新 flow
- **Subflow**：面板含 `Subflow`；节点检查器提供 `flow_version_id` 字段（文本输入即可）；样例图演示父图 + 已发布子图
- **指标**：选中当前 flow 后展示 totals 的简单面板（请求 `GET /metrics/flows/:id`）
- 保持基于轮询的 run UI；无 WS

## 7. 验收标准

1. 含 `Subflow` 的父图 → 指向已发布子图的 `flow_version_id` 能展开；试运行成功；时间线显示带前缀的子节点 id。
2. 环 / 深度 > 3 / 缺 Start|End → 发布门禁 `subflow_refs` 失败（展开对 run 抛出稳定错误码）。
3. Developer 从已发布版本创建模板；builder 克隆为带拷贝节点的新草稿 flow。
4. Viewer 可 `GET` 指标；若干次 run 后，`success_rate` / `avg_latency_ms` / `sum_cost_tokens` 与 SQL 预期一致。
5. `pnpm test:m5` 绿；`test:m2` / `test:m3` / `test:m4` 仍绿。
6. 无 CRDT、无 WS、无新指标仓。

## 8. 批准

已批准进入规划；通过 `docs/superpowers/plans/2026-10-22-m5-subflow-templates-metrics.md` 实现。
