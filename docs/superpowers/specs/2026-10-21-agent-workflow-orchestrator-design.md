# Design Spec: 智能体可视化编排系统（拖拽流程）

- Date: 2026-10-21
- Status: approved; M1 plan in `docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`; M2 plan in `docs/superpowers/plans/2026-10-21-m2-python-executor-test-run-timeline.md`; M3 design in `docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md`; M3 plan in `docs/superpowers/plans/2026-10-22-m3-breakpoint-signal-human-approval.md`; M4 design in `docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md`; M4 plan in `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md`
- Product positioning: 编排画布 + 运行时调试/回放（混合）
- Architecture: 方案 A — TypeScript 控制面 + 语言无关 Graph JSON + 可插拔 HTTP/gRPC 执行器

## 1. Goals

构建一套可通过拖拽定义业务流程/智能体流水线的系统，支持：

1. 可视化编排（节点、条件边、子流程、版本发布）
2. 独立 Runtime 执行已发布图，并支持试运行、断点、时间线回放
3. 开发者与产品/运营双角色，权限分层
4. 图定义与执行语言解耦，便于 Python/TS/Go 等执行器接入

非目标（第一版不做或仅占位）：

- 多画布实时协作编辑（CRDT）
- 完整可观测商业套件（可先做基础指标）
- 完整自定义节点市场
- 多区域多活部署

## 2. Constraints (agreed)

| 项 | 选择 |
|---|---|
| 产品形态 | 混合：编排 + 运行时调试 |
| 部署 | 前后端分离，Runtime 单独服务 |
| 使用者 | Developer + Builder（产品/运营），权限分层 |
| 执行绑定 | 语言无关：JSON 图 + HTTP/gRPC 执行器 |
| UI 风格参考 | 浅色底；圆角节点+左侧图标；端口圆点；主路径蓝；失败/兜底橙红；边条件文案；菱形判断节点 |

## 3. Architecture (Option A)

```
[Web Canvas (React + XYFlow)]
        |  REST / WS
[Control Plane API (TypeScript)]
        |  publish graph_version / create run / signal
[Runtime Gateway]
        |  HTTP or gRPC job stream
[Executor Worker(s)]  ← Python first, swappable
```

Responsibilities:

- **Canvas**: 编辑 draft graph、配置节点、触发试运行、展示 run timeline
- **Control Plane**: 用户/权限、资产（模型/工具/知识库）、Flow 版本、Run 元数据与事件持久化、审计
- **Runtime / Executor**: 只消费不可变 `graph_json` + run input；上报 `run_events`；处理 breakpoint / human signal

Language decision: **不是 Python vs TS 二选一**。控制面与实时调试用 TypeScript；Agent/LLM 生态优先用 Python Executor；契约是 Graph JSON + Run Protocol。

## 4. Node Catalog (v1)

### 4.1 Control flow

- `Start` / `End`
- `Branch`（条件/表达式或 LLM 分类）
- `Switch`
- `Loop`（定次 / while / foreach）
- `Parallel`（all / any / N）+ join
- `Wait`（延时或外部事件）
- `Subflow`

### 4.2 Agent / LLM

- `LLM`
- `Agent`（工具循环，max steps）
- `RouterAgent`
- `MemoryRead` / `MemoryWrite`
- `StructuredParse`

### 4.3 Knowledge

- `KnowledgeRetrieve`
- `Rerank`
- `DocLoader`（可二期强化）

### 4.4 Tools / integration

- `HTTP`
- `Tool`（注册表具名工具）
- `Code`（沙箱，仅 developer+）
- `MCP` / 外部协议（二期）

### 4.5 Human & debug

- `HumanApproval`
- `Input`
- `Emit`
- `Breakpoint`

### 4.6 Data

- `SetState`
- `Transform`
- `Merge`

### 4.7 Node contract

每个节点：`type`, `config`, input/output ports, `retry`, `timeout`, `on_error` (`fail` | `fallback` | `continue`)。

边：`kind: success | failure | default` + 可选 `label`（对齐参考图「查询成功/失败」）。

## 5. Use Cases

### Orchestration

1. 对话 Agent：Start → Router → 子图/工具 Agent/转人工 → End
2. RAG：Retrieve → Rerank → LLM → 引用校验 → End
3. 多工具业务流：规划 → Parallel → Merge → StructuredParse → 写回
4. 审批流：业务节点 → HumanApproval → Branch
5. Subflow 复用
6. 模板克隆起稿（Builder 主路径）
7. 版本 diff 后发布

### Runtime / debug

8. 试运行（样例输入，看每节点 IO）
9. 断点调试，改 state 续跑
10. Run timeline 回放
11. Parallel 分支观测
12. HumanApproval / Input 控制台续跑
13. 回归用例包（可紧随 v1）

### Governance

14. 角色可见节点/工具过滤
15. 发布门禁（试运行/必填配置）
16. 审计

**v1 priority**: 1, 2, 3, 6, 8, 9, 10, 14, 15.

## 6. Feature List

### Canvas & graph

- 拖拽、连线、对齐/分组、小地图、撤销重做
- 端口类型校验、必填配置提示
- 子图钻取、模板、导入导出 Graph JSON
- 草稿自动保存 + 显式版本
- UI variant：颜色/图标按 `node_defs.ui_meta`（对齐样式参考）

### Assets

- 节点面板按角色过滤
- 工具/模型/知识库注册与授权
- 自定义节点 SDK（v1 骨架）

### Runtime & debug

- 发布不可变 `flow_version`
- test/prod run；WS 推送节点状态
- 断点、单步、改 state、单节点重试
- Run Timeline（IO、耗时、token、错误）
- 历史回放

### AuthZ

- Roles: `admin` | `developer` | `builder` | `viewer`
- 资源级：workspace / project / flow / tool / credential
- 可选发布审批；审计日志

### Observability (thin v1)

- 成功率、延迟、成本按 flow/version 聚合
- 基础失败告警占位

### Protocols

- Graph JSON Schema
- Run API: createRun / signal / cancel
- Executor: pull or push job + event stream (HTTP callback or gRPC)

## 7. Graph JSON (sketch)

```json
{
  "id": "flow_ver_xxx",
  "state_schema": { "type": "object", "properties": {} },
  "nodes": [
    {
      "id": "n1",
      "type": "Branch",
      "config": {},
      "ui": { "x": 120, "y": 80, "variant": "decision" }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "n1",
      "sourceHandle": "success",
      "target": "n2",
      "targetHandle": "in",
      "kind": "success",
      "label": "查询成功"
    }
  ]
}
```

## 8. E-R (Control Plane)

```
Workspace 1—N Project 1—N Flow 1—N FlowVersion
FlowVersion 1—N Run 1—N RunEvent
Workspace 1—N (NodeDef | Tool | Model | KnowledgeBase | Credential)
User — Membership(role) — Workspace
```

### Tables

| Table | Key fields |
|---|---|
| `users` | id, email, name |
| `workspaces` | id, name |
| `memberships` | workspace_id, user_id, role |
| `projects` | id, workspace_id, name |
| `flows` | id, project_id, name, latest_draft_version_id, published_version_id |
| `flow_versions` | id, flow_id, version, status(draft/published/archived), graph_json, schema_hash, created_by, created_at |
| `node_defs` | id, workspace_id, type_key, category, config_schema, ui_meta, min_role |
| `tools` | id, workspace_id, name, kind, config_encrypted, allowed_roles |
| `models` | id, workspace_id, provider, name, config |
| `knowledge_bases` | id, workspace_id, name, config |
| `credentials` | id, workspace_id, provider, secret_ref |
| `runs` | id, flow_version_id, trigger(test/prod/api), status, input_json, output_json, started_at, finished_at, cost_tokens |
| `run_events` | id, run_id, seq, node_id, event_type, payload_json, ts |
| `run_breakpoints` | id, run_id, node_id, active |
| `run_signals` | id, run_id, kind(approval/input/resume), payload_json, status |
| `audit_logs` | actor, action, resource_type, resource_id, diff_json, ts |

Runtime optional: `executor_jobs` for local queue; not required if gateway is push-based.

## 9. Security notes

- Secrets only via `credentials.secret_ref`，不进 `graph_json`
- `Code` 节点强制沙箱 + 仅 developer+
- Builder 不可见未授权工具/节点类型
- Published version immutable；变更必须新版本

## 10. Tech stack recommendation (v1)

| Layer | Choice |
|---|---|
| Canvas | React + TypeScript + XYFlow (React Flow) |
| Control plane | NestJS or Hono + PostgreSQL + Redis (WS/pubsub) |
| Executor | Python worker first (HTTP or gRPC) |
| Contract | JSON Schema for graph + OpenAPI/Protobuf for run protocol |

## 11. Phased delivery

1. **M1**: Graph CRUD + version + canvas style baseline + publish
2. **M2**: Python executor + test run + run_events timeline
3. **M3**: Breakpoint / signal / human approval
4. **M4**: Roles + asset registry + publish gate
5. **M5**: Subflow, templates, thin metrics

## 12. Open items (resolve in planning if needed)

- DB: PostgreSQL confirmed?
- Auth: 自建 session vs OIDC?
- First executor transport: **HTTP push job + HTTP callback** (resolved in M2 plan; gRPC deferred)
- Monorepo vs multi-repo?

## 13. Approval

Discussed and agreed in chat (2026-10-21): product shape, deploy shape, dual personas, language-agnostic runtime, Option A, node catalog, use cases, features, E-R, UI style reference.

Awaiting user review of this written spec before implementation planning.
