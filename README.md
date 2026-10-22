# 智能体工作流编排器（Agent Workflow Orchestrator）

拖拽式智能体 / 流程编排系统（M1：画布 + 控制面草稿/发布；M2：Python 执行器 + 试运行时间线；M3：断点 / signal / 人工审批；M4：角色 / 资产注册表 / 发布门禁；M5：子流程 / 模板 / 薄指标）。

- **架构（方案 A）**：TypeScript 控制面 + 语言无关 Graph JSON + HTTP 执行器（回调）。
- **Monorepo**：`apps/web`（Vite + React + XYFlow）、`apps/control-plane`（Hono + Drizzle + PostgreSQL）、`apps/executor-py`（FastAPI）、`packages/graph-schema` / `packages/run-protocol`。
- **设计文档**：`docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md`
- **M1 实现计划**：`docs/superpowers/plans/2026-10-21-m1-graph-canvas-control-plane.md`
- **M2 实现计划**：`docs/superpowers/plans/2026-10-21-m2-python-executor-test-run-timeline.md`
- **M3 设计 / 实现计划**：`docs/superpowers/specs/2026-10-22-m3-breakpoint-signal-human-approval-design.md` · `docs/superpowers/plans/2026-10-22-m3-breakpoint-signal-human-approval.md`
- **M4 设计 / 实现计划**：`docs/superpowers/specs/2026-10-22-m4-roles-assets-publish-gate-design.md` · `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md`
- **M5 设计 / 实现计划**：`docs/superpowers/specs/2026-10-22-m5-subflow-templates-metrics-design.md` · `docs/superpowers/plans/2026-10-22-m5-subflow-templates-metrics.md`
- **运行协议草图**：`docs/run-protocol-openapi.md`

## 环境要求

- Node.js ≥ 20
- pnpm
- Docker（Postgres 16）
- Python ≥ 3.11（M2 执行器）

## 本地启动

### 一键启动（推荐）

macOS / Linux / **WSL**：

```bash
pnpm dev:up
# 或: bash scripts/dev-up.sh
```

原生 Windows（PowerShell，需已安装 Node / pnpm / Docker Desktop / Python ≥ 3.11）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-up.ps1
```

脚本会依次：检查依赖 → `pnpm install` → 启动 Postgres → 迁移并灌入演示数据 → 准备执行器虚拟环境 → 后台启动 API（`:8787`）、执行器（`:8792`）、前端（`:5173`）。日志与进程号在 `.logs/`。浏览器打开 [http://localhost:5173](http://localhost:5173)。

停止（Windows）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev-down.ps1
```

停止（macOS / Linux / WSL）：

```bash
kill $(awk '{print $2}' .logs/pids.txt)
```

默认环境变量：`DATABASE_URL=postgres://awo:awo@localhost:5432/awo`、`EXECUTOR_TOKEN=dev`、`EXECUTOR_URL=http://127.0.0.1:8792`、`CALLBACK_BASE_URL=http://127.0.0.1:8787`、`PORT=8787`。前端使用 `apps/web/.env`（若不存在会从 `.env.example` 复制，`VITE_API_BASE=http://localhost:8787`）。

> 说明：`pnpm dev:executor` 仍默认占用 `:8790`；一键脚本为避免端口冲突改用 **8792**。
>
> Windows 上若本机 pnpm 开启了「包发布未满 24 小时禁止安装」策略，一键脚本与 `pnpm dev:api` / `pnpm dev:web` 已内置 `--config.minimumReleaseAge=0` 绕过；手动跑 `pnpm install` 时也可加上同一参数。

### 手动分步启动

```bash
# 1. 安装 JS 工作区依赖
pnpm install

# 2. 启动 Postgres（localhost:5432，库/用户/密码均为 awo）
pnpm db:up

# 3. 迁移 + 灌入演示用户 / 工作区 / 项目 / 节点定义
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
pnpm --filter @awo/control-plane db:migrate
pnpm --filter @awo/control-plane db:seed

# 4. Python 执行器虚拟环境（只需做一次）
cd apps/executor-py && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && cd ../..

# 5. 控制面 ↔ 执行器 共享密钥
export EXECUTOR_TOKEN=dev
export EXECUTOR_URL=http://127.0.0.1:8790
export CALLBACK_BASE_URL=http://127.0.0.1:8787
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo

# 6. 三个进程（分别开三个终端）
pnpm dev:api          # 控制面 :8787
pnpm dev:executor     # FastAPI 执行器 :8790（需要 EXECUTOR_TOKEN）
pnpm dev:web          # Vite 前端 :5173
```

Windows PowerShell 手动启动示例：

```powershell
$env:DATABASE_URL='postgres://awo:awo@localhost:5432/awo'
$env:EXECUTOR_TOKEN='dev'
$env:EXECUTOR_URL='http://127.0.0.1:8792'
$env:CALLBACK_BASE_URL='http://127.0.0.1:8787'

# 终端 1：执行器
cd apps\executor-py; .venv\Scripts\python.exe -m uvicorn awo_executor.main:app --port 8792

# 终端 2：控制面（项目根目录）
pnpm --filter ./apps/control-plane dev

# 终端 3：前端
pnpm --filter ./apps/web dev
```

打开 [http://localhost:5173](http://localhost:5173)。

### 环境变量说明

| 变量 | 使用方 | 默认值 / 说明 |
|---|---|---|
| `DATABASE_URL` | 控制面 | 必填；例如 `postgres://awo:awo@localhost:5432/awo` |
| `PORT` | 控制面 | `8787` |
| `EXECUTOR_URL` | 控制面 | `http://127.0.0.1:8790` — 任务 POST 目标（一键脚本用 8792） |
| `EXECUTOR_TOKEN` | 控制面 **与** 执行器 | 必填共享密钥；控制面未设置时无法派发任务 |
| `CALLBACK_BASE_URL` | 控制面（写入 Job） | `http://127.0.0.1:8787` — 执行器回调地址 |
| `VITE_API_BASE` | 前端 | `http://localhost:8787`（见 `apps/web/.env.example`） |
| `X-User-Id` | HTTP 头（临时鉴权） | 前端用户切换：`u_admin` / `u_dev` / `u_builder` / `u_viewer`。OIDC 延后（M4 之后） |

若 API 地址非默认，请复制 `apps/web/.env.example` → `apps/web/.env` 再修改。

## 包一览

| 包 | 作用 |
|---|---|
| `@awo/graph-schema` | 共享的 Zod 图结构 + 内容哈希 |
| `@awo/run-protocol` | 运行状态 / 事件 / JobPayload / 回调的 Zod 定义 |
| `@awo/control-plane` | REST：流程、发布门禁、试运行、资产、角色、signal/状态/断点、模板、指标、执行器回调 |
| `@awo/web` | XYFlow 画布 + 试运行 / Signal 面板 / 用户切换 / 节点面板 / 资产 / 模板 / 指标 |
| `apps/executor-py` | Python 图引擎 + `POST /v1/jobs` |

## M1 验收清单

环境就绪后，手工冒烟（API + UI）：

1. **创建 / 打开演示流程** — 使用「新建演示流程」，或重新打开项目 `p_demo` 下已记住的流程。
2. **编辑图** —「添加 Branch」，用带标签的边连接 **success** / **failure**（蓝 / 橙红路径）。
3. **保存草稿 → 刷新仍在** —「保存草稿」后刷新页面，节点与边从服务端恢复。
4. **发布不可变** —「发布」会写入 `publishedVersionId`；之后再编辑并保存会生成 **新** 草稿（`versionId` / `schemaHash` 变化），**不会**改写已发布的 `flow_versions` 行。发布前会先保存当前画布草稿。

## M2 验收清单

需要控制面 + 执行器 + 前端（环境变量同上）。Happy path 图仅含 `Start` / `Transform` / `Branch` / `Emit` / `End`（不含 HTTP / HumanApproval）。

1. **先发布** — 画布「试运行」要求已有发布版本；未发布会给出明确错误。
2. **发起试运行** — 打开试运行面板，提交 JSON `input`，创建运行（`POST /flows/:id/test-runs`）。
3. **时间线轮询** — 事件按单调递增的 `seq` 出现（`run_started` → 节点事件 → `run_finished`）；状态从 `queued` → `running` → `succeeded`（或 `failed`）。
4. **执行器往返** — 控制面向 `EXECUTOR_URL/v1/jobs` POST `JobPayload`；执行器用 `X-Executor-Token` 回调 `/internal/runs/:id/events` 与 `/status`。
5. **集成测试** — Postgres 已启动且执行器依赖已安装时：

```bash
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
export EXECUTOR_TOKEN=test-executor-token-m2
pnpm test:m2
```

M2 不做（交给 M3+）：断点 / signal / HumanApproval；角色 / 资产 / 发布门禁（M4）；子流程 / 模板 / 指标（M5）；WebSocket 推送（仅轮询）；草稿干跑；执行器中途取消。

## M3 验收清单

需要控制面 + 执行器 + 前端（环境同 M2）。演示使用 **M3 示例图**（`Start` → `Transform` → `Breakpoint` → `HumanApproval` → 分支 → `End`），前端默认加载（`apps/web/src/sample-m3-graph.ts`）。

1. **断点暂停 → 改状态 → 继续** — 发布后试运行；命中 `Breakpoint`（或画布开关 / `PUT …/breakpoints` 动态断点）→ 状态 `paused`，时间线出现 `breakpoint_hit`。在状态编辑器改状态（`PATCH …/state` → `state_patched`），再 Resume（`POST …/signal`，`kind: resume` → `signal_received`）→ 继续跑到成功（或下一个暂停点）。
2. **HumanApproval** — Approve 走 **success** 边；Reject 走 **failure**（若无 failure 边则回退 `default`）。
3. **Input** — 图中含 `Input` 节点时，提交的值并入 state，后续 Emit / Transform 可见。
4. **暂停中取消** — Cancel → 立即 `cancelled`，执行器不再继续。
5. **轮询** — `paused` 期间时间线继续轮询；仅终态停止。
6. **集成测试**：

```bash
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
export EXECUTOR_TOKEN=test-executor-token-m3
pnpm test:m3
```

M3 之后 `pnpm test:m2` 仍须通过。

本地跑示例：启动 Postgres + migrate/seed，导出 `EXECUTOR_TOKEN` / `EXECUTOR_URL` / `CALLBACK_BASE_URL` / `DATABASE_URL`，再开 `pnpm dev:api`、`pnpm dev:executor`、`pnpm dev:web`。打开 `http://localhost:5173`，发布 M3 演示流程，打开试运行，提交 input，按上面用 Signal 面板 / 断点操作。

M3 不做：显式 `step` API、WebSocket/SSE 推送、多审批人路由 / SLA、M4 角色资产门禁、M5 子流程模板指标、草稿干跑。

## M4 验收清单

需要已执行迁移（`0004_m4_roles_assets_gate`）并重新 seed 演示用户 / 资产。临时鉴权仍为 `X-User-Id`。

**角色**（等级：viewer=0 < builder=1 < developer=2 < admin=3）：

| id | 角色 |
|---|---|
| `u_admin` | admin |
| `u_dev` | developer |
| `u_builder` | builder |
| `u_viewer` | viewer |

1. **节点可见性** — Builder 的 `GET /node-defs` 不含 `Code` / `Breakpoint`；developer 及以上可见。前端节点面板按过滤结果加载。
2. **写操作守卫** — Viewer 不能保存草稿 / 发布 / 创建运行 / 发 signal（403）。Builder 可编辑 / 发布 / 对已发布版本试运行；仅 developer 及以上可做 `graph_source: "draft"` 试运行与资产写入。
3. **资产** — `GET/POST/PATCH/DELETE /assets/tools|models|knowledge-bases`；seed 示例 `demo_echo` / `demo_stub` / `demo_kb`。
4. **发布门禁** — 发布前检查：`required_config`（如 HTTP 需要 `url`）、`successful_test_run`（首次发布 / bootstrap 可跳过）、`role_nodes`。失败 → `400 { error: "publish_gate_failed", checks: [...] }`。
5. **草稿解锁** — 首次发布后，改草稿再发布会被拦住，直到有一次成功试运行的 `schema_hash` 与草稿一致（建议走 developer 的草稿试运行）。
6. **前端** — 用户切换、按角色过滤的节点面板、资产面板、状态栏展示门禁错误。
7. **集成测试**：

```bash
export DATABASE_URL=postgres://awo:awo@localhost:5432/awo
export EXECUTOR_TOKEN=test-executor-token-m4
pnpm test:m4
```

M4 之后 `pnpm test:m2` 与 `pnpm test:m3` 仍须通过。

M4 不做：OIDC / SSO、密钥保险库、多人审批发布、M5 子流程/模板/指标、WS 推送。

## M5 验收清单

1. **子流程展开** — 父草稿中 `Subflow.config.flow_version_id` 指向同工作区 **已发布** 子流程；developer 草稿试运行成功；时间线出现带前缀的子节点 id（`sf__…`）。
2. **发布门禁 `subflow_refs`** — 子版本缺失或非法 → `400 publish_gate_failed`，检查项 `subflow_refs`。
3. **模板** — developer `POST /templates` 从已发布版本建模板；builder `POST /templates/:id/clone` → 新草稿流程（节点已拷贝）；前端「从模板创建」打开它。
4. **薄指标** — viewer `GET /metrics/flows/:id` 与 `/metrics/workspace`；UI「刷新指标」展示 success_rate / avg_latency_ms / sum_cost_tokens。
5. **回归** — `pnpm test:m5` 通过；`test:m2` / `test:m3` / `test:m4` 仍绿。不做 CRDT / WS / 指标数仓。

```bash
pnpm test:m5
```

## 测试

```bash
pnpm test
# 或按包：
pnpm --filter @awo/graph-schema test
pnpm --filter @awo/run-protocol test
pnpm --filter @awo/control-plane test   # 需要 DATABASE_URL
pnpm --filter @awo/web test
pnpm test:m2                            # 控制面 + 真实执行器 happy path
pnpm test:m3                            # 暂停 → signal → 继续（真实执行器）
pnpm test:m4                            # 角色 / 资产 / 发布门禁
pnpm test:m5
cd apps/executor-py && .venv/bin/python -m pytest
```

## 许可证

私有 / 未公开发布。