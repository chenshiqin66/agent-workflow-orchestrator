# 设计规格：M4 — 角色 + 资产注册表 + 发布门禁

- 日期：2026-10-22
- 状态：已批准；计划见 `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md`
- 上级规格：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`（§11 M4；§6 AuthZ/Assets；§8 E-R；§9 Security）
- 依赖：M1（图 + 发布）+ M2（试运行）+ M3（暂停/信号 — M4 不改其语义）
- 鉴权选型（已锁定）：继续使用占位 **`X-User-Id`** + `memberships.role`（不做 OIDC）

## 1. 目标

在 M1–M3 之上交付治理能力：

1. **角色** — 对节点可见性与变更类 API 强制 `admin | developer | builder | viewer`
2. **资产注册表** — workspace 级 `tools`、`models`、`knowledge_bases` 的最小 CRUD
3. **发布门禁** — 除非必填节点配置通过且存在匹配的成功试运行，否则阻止发布

非目标（明确不在 M4 范围）：

- OIDC / session cookie / SSO
- 真实密钥库 / 加密（`credentials` 表延后；资产可在 config JSON 中存不透明 `secret_ref` 字符串）
- 多审批人发布流程 / 邮件通知 / SLA
- 自定义节点 SDK 市场
- 超出 workspace 成员 + 角色的资源级 ACL
- 改变 M3 暂停/信号语义
- Subflow / 模板 / 指标（属 M5）

## 2. 当前基线（已有能力）

| 领域 | 现状 |
|---|---|
| Auth | `authMiddleware` 解析 `X-User-Id` → 首条 `memberships` 记录；设置 `userId`、`workspaceId`、`role` |
| Seed | 单一用户 `u_dev` / 角色 `developer`；所有 `node_defs.min_role = "builder"` |
| 节点定义 | `GET /node-defs` 返回该 workspace **全部** defs（无角色过滤） |
| 发布 | `publishFlow` 将草稿复制为不可变已发布版本；**无**配置/试运行门禁 |
| 试运行 | **仅已发布**（`run-service`）；builder 与 developer 同等对待 |
| 资产 | 表**缺失**（`tools` / `models` / `knowledge_bases` 不在 Drizzle schema 中） |

## 3. 角色模型

### 3.1 等级

```
viewer = 0 < builder = 1 < developer = 2 < admin = 3
```

辅助函数：`roleAtLeast(role, minRole) => rank(role) >= rank(minRole)`。

无效 / 未知角色字符串 → 视为低于 viewer（拒绝）。

### 3.2 能力（M4）

| 动作 | viewer | builder | developer | admin |
|---|---|---|---|---|
| GET flow / versions / runs / events / node-defs / assets | ✓ | ✓ | ✓ | ✓ |
| 保存草稿 / 创建 flow | ✗ | ✓ | ✓ | ✓ |
| 发布（过门禁后） | ✗ | ✓ | ✓ | ✓ |
| 试运行**已发布** | ✗ | ✓ | ✓ | ✓ |
| 试运行**草稿**（门禁校验用） | ✗ | ✗ | ✓ | ✓ |
| 资产写（创建/更新/删除） | ✗ | ✗ | ✓ | ✓ |
| 查看 `min_role=developer` 的节点（如 `Code`） | ✗ | ✗ | ✓ | ✓ |
| 取消 / 信号 / 断点 / 修改 state | ✗ | ✓ | ✓ | ✓ |

Viewer 只读。Builder 是产品/运营编辑路径。Developer 解锁 Code 类节点、草稿试运行与资产管理。

### 3.3 节点可见性

- `GET /node-defs` **过滤**为满足 `roleAtLeast(caller.role, def.minRole)` 的 defs。
- Seed 调整：
  - 多数节点：`min_role = builder`
  - `Code`：`min_role = developer`（增加 `Code` node_def；执行器仍可 stub/失败执行 —— M4 仅管可见性）
  - `Breakpoint`：`min_role = developer`（偏调试）
- 可选发布检查：草稿不得包含 `min_role` 高于发布者角色的节点 `type`（门禁检查 `role_nodes`）。

### 3.4 Seed 用户（演示）

| id | role |
|---|---|
| `u_admin` | admin |
| `u_dev` | developer（已有） |
| `u_builder` | builder |
| `u_viewer` | viewer |

均属于 `ws_demo`。Web 演示可在这些用户间切换 `X-User-Id`。

## 4. 资产注册表

### 4.1 表

```
tools(
  id, workspace_id, name, kind,           -- kind: http | function | other
  config_json,                            -- 自由格式；可含 secret_ref 字符串
  allowed_roles,                          -- jsonb string[] 例如 ["builder","developer","admin"]
  created_at, updated_at
)

models(
  id, workspace_id, provider, name,
  config_json,
  created_at, updated_at
)

knowledge_bases(
  id, workspace_id, name,
  config_json,
  created_at, updated_at
)
```

M4 不做 `credentials` 表（YAGNI 密钥库）。Seed 数据中不要放真实密钥。

唯一约束：每张资产表 `(workspace_id, name)`。

### 4.2 API

基路径前缀 `/assets`（需鉴权）。

| 方法 | 路径 | 最低角色 |
|---|---|---|
| `GET` | `/assets/tools` | viewer+ |
| `POST` | `/assets/tools` | developer+ |
| `GET` | `/assets/tools/:id` | viewer+ |
| `PATCH` | `/assets/tools/:id` | developer+ |
| `DELETE` | `/assets/tools/:id` | developer+ |
| 同模式 | `/assets/models`、`/assets/knowledge-bases` | 同上 |

列出 tools 时进一步按 `allowed_roles` 包含调用者角色过滤（空/缺失 = workspace 内全部角色）。

Body：Zod 校验 `{ name, kind?, config?, allowed_roles? }` 等。workspace 不符返回 404。

### 4.3 Seed 样例

- Tool `demo_echo`（kind `function`，allowed_roles 覆盖全部可编辑角色）
- Model `demo_stub`（provider `stub`）
- Knowledge base `demo_kb`

图节点可在 `config` 中用 id 引用资产（`tool_id`、`model_id`、`knowledge_base_id`）；当这些键存在/按类型必填时，发布门禁校验引用是否存在。

## 5. 发布门禁

### 5.1 时机

`POST /flows/:flowId/publish` 在创建不可变已发布版本**之前**跑门禁。失败 → `400` 结构化 body（不做部分发布）。

```json
{
  "error": "publish_gate_failed",
  "checks": [
    { "id": "required_config", "ok": false, "message": "node n_http: missing config.url" },
    { "id": "successful_test_run", "ok": true },
    { "id": "role_nodes", "ok": true }
  ]
}
```

### 5.2 检查项

1. **`required_config`**
   - 对草稿中每个节点，按 `type_key`（workspace）加载 `node_defs`。
   - 若 `config_schema` 含 JSON Schema `required: [...]`，确保这些键存在且非空（字符串/数组/对象规则：非空字符串；非 null）。
   - 类型特有附加项（小硬编码映射）：
     - `HTTP` → `url`
     - `Tool` → `tool_id` 必须存在于该 workspace 的 `tools`
     - `LLM` / `Agent` → 当 schema 必填或键已设置时，`model_id` 必须存在于 `models`
     - `KnowledgeRetrieve` → 键已设置/必填时，`knowledge_base_id` 必须存在
   - `config_schema.required` 为空且无类型附加项的节点通过。

2. **`successful_test_run`**
   - 草稿 `schema_hash` = `hashGraph(draft.graph)`（与保存相同）。
   - 若存在该 **flow** 的 `runs` 行满足以下条件则通过：
     - `trigger = 'test'`
     - `status = 'succeeded'`
     - 关联的 `flow_versions.schema_hash === draft.schema_hash`
   - **冷启动例外：** 若 `flows.publishedVersionId` 为 null（从未发布），本检查**跳过**（ok=true，message=`bootstrap_skip`）。首次发布只需 `required_config`（+ `role_nodes`）。之后每次发布都需要匹配的成功试运行。

3. **`role_nodes`**
   - 草稿中每个节点类型须满足 `roleAtLeast(publisher.role, node_def.minRole)`。
   - 未知类型（无 node_def）→ 检查失败。

### 5.3 草稿试运行（解决先有鸡还是先有蛋）

M2「仅已发布」规则对 developer+ **放宽**：

- `POST /flows/:flowId/runs` body：`{ input: object, graph_source?: "published" | "draft" }`
- 默认 `graph_source = "published"`（向后兼容）。
- `graph_source = "draft"`：仅 `developer` / `admin`；对**当前草稿** `flow_versions` 行创建 run（状态仍为 `draft`；run 仍指向该 version id）。执行器照常收到该版本的 `graph_json`。
- Builder 请求草稿 → `403`。
- 已发布路径对 builder+ 不变。

这样 developer 可以：编辑草稿 → 草稿试运行 → 成功 → 发布（门禁看到匹配 hash）。

## 6. 控制面强制点

| 路由 / 服务 | 变更 |
|---|---|
| `listNodeDefs` | 按调用者角色过滤 |
| `saveDraft` / `createFlow` / `publishFlow` | 要求 builder+ |
| `publishFlow` | 跑门禁；需要 `role` 参数 |
| `createTestRun` | 角色检查 + 可选草稿来源 |
| runs signal/state/breakpoints/cancel | 要求 builder+ |
| 新 assets 路由 | 见 §4.2 |
| `auth` | 可选校验 role ∈ 已知集合 |

审计：现有 `flow.publish` 审计保留；门禁失败时**不**写发布审计。资产 CRUD 可选写 `audit_logs`（`asset.create` 等）—— 有余力再做。

## 7. Web UI（精简）

- **用户切换器**：在 seed 用户 id 间选择 → 设置客户端 `X-User-Id`（可用 localStorage）。
- **面板**：加载 `listNodeDefs()`（服务端已过滤）；勿为 builder 硬编码仅 developer 可见类型。
- **资产面板**：列出 tools/models/KB；developer+ 可用简单表单创建/删除（name + JSON config）。
- **发布**：在状态/错误 UI 展示 `publish_gate_failed.checks`；勿假装成功。
- 不引入新设计系统；复用 M2/M3 现有工具栏/面板 CSS 模式。

## 8. 迁移与脚本

- 迁移名写死：`0004_m4_roles_assets_gate`
- 增加 `tools`、`models`、`knowledge_bases` 表
- Seed 更新：用户 + memberships + Code/Breakpoint min_role + 样例资产；为演示收紧部分 HTTP/LLM 的 `config_schema.required`
- 根脚本：`test:m4` → vitest `tests/m4-integration.test.ts`（沿用 `test:m3` 模式）

## 9. 验收标准

1. Builder 的 `GET /node-defs` 不含 `Code`；developer 能看到 `Code`。
2. Viewer 不能 `PUT` 草稿 / `POST` 发布 / 创建 run（403）。
3. Developer 可 CRUD tools/models/knowledge_bases；builder 对资产仅 GET。
4. 缺少 HTTP `url` 时发布 → 400 `publish_gate_failed` / `required_config`。
5. 首次发布后，改草稿且未对新 hash 跑成功试运行就发布 → 400 `successful_test_run`。
6. Developer 草稿试运行后以匹配 hash 发布 → 200 published。
7. `pnpm test:m4` 以及现有 `test:m2` / `test:m3` 仍绿（builder 的 M2 已发布默认路径不变）。

## 10. 批准

已批准执行；通过 `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md` 实现（分支 `feature/m4-roles-assets-publish-gate`）。
