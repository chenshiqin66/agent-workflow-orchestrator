# Design Spec: M4 — Roles + Asset Registry + Publish Gate

- Date: 2026-10-22
- Status: approved; plan in `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md`
- Parent: `docs/superpowers/specs/2026-10-21-agent-workflow-orchestrator-design.md` (§11 M4; §6 AuthZ/Assets; §8 E-R; §9 Security)
- Depends on: M1 (graph + publish) + M2 (test run) + M3 (pause/signal — unchanged by M4)
- Auth choice (locked): keep stub **`X-User-Id`** + `memberships.role` (no OIDC)

## 1. Goal

Ship governance on top of M1–M3:

1. **Roles** — enforce `admin | developer | builder | viewer` for node visibility and mutating APIs
2. **Asset registry** — minimal CRUD for workspace `tools`, `models`, `knowledge_bases`
3. **Publish gate** — block publish unless required node config passes and a successful matching test-run exists

Non-goals (explicitly out of M4):

- OIDC / session cookies / SSO
- Real secrets vault / encryption (`credentials` table deferred; assets may store opaque `secret_ref` strings in config JSON only)
- Multi-approver publish workflow / email notify / SLA
- Custom node SDK marketplace
- Per-resource ACL beyond workspace membership + role
- Changing M3 pause/signal semantics
- Subflow / templates / metrics (M5)

## 2. Current baseline (what exists)

| Area | Today |
|---|---|
| Auth | `authMiddleware` resolves `X-User-Id` → first `memberships` row; sets `userId`, `workspaceId`, `role` |
| Seed | Single user `u_dev` / role `developer`; all `node_defs.min_role = "builder"` |
| Node defs | `GET /node-defs` returns **all** defs for workspace (no role filter) |
| Publish | `publishFlow` copies draft → immutable published version; **no** config/test gates |
| Test run | **Published-only** (`run-service`); builders and developers treated the same |
| Assets | Tables **missing** (`tools` / `models` / `knowledge_bases` not in Drizzle schema) |

## 3. Role model

### 3.1 Rank

```
viewer = 0 < builder = 1 < developer = 2 < admin = 3
```

Helper: `roleAtLeast(role, minRole) => rank(role) >= rank(minRole)`.

Invalid / unknown role strings → treat as below viewer (deny).

### 3.2 Capabilities (M4)

| Action | viewer | builder | developer | admin |
|---|---|---|---|---|
| GET flow / versions / runs / events / node-defs / assets | ✓ | ✓ | ✓ | ✓ |
| Save draft / create flow | ✗ | ✓ | ✓ | ✓ |
| Publish (after gate) | ✗ | ✓ | ✓ | ✓ |
| Test-run **published** | ✗ | ✓ | ✓ | ✓ |
| Test-run **draft** (gate validation) | ✗ | ✗ | ✓ | ✓ |
| Asset write (create/update/delete) | ✗ | ✗ | ✓ | ✓ |
| See nodes with `min_role=developer` (e.g. `Code`) | ✗ | ✗ | ✓ | ✓ |
| Cancel / signal / breakpoints / patch state | ✗ | ✓ | ✓ | ✓ |

Viewer is read-only. Builder is the product/ops editing path. Developer unlocks Code-class nodes, draft test-runs, and asset admin.

### 3.3 Node visibility

- `GET /node-defs` **filters** to defs where `roleAtLeast(caller.role, def.minRole)`.
- Seed adjustments:
  - Most nodes: `min_role = builder`
  - `Code`: `min_role = developer` (add `Code` node_def; executor may still stub/fail execute — visibility only in M4)
  - `Breakpoint`: `min_role = developer` (debug-oriented)
- Optional publish check: draft must not contain a node `type` whose `min_role` exceeds publisher role (gate check `role_nodes`).

### 3.4 Seed users (demo)

| id | role |
|---|---|
| `u_admin` | admin |
| `u_dev` | developer (existing) |
| `u_builder` | builder |
| `u_viewer` | viewer |

All members of `ws_demo`. Web demo may switch `X-User-Id` among these.

## 4. Asset registry

### 4.1 Tables

```
tools(
  id, workspace_id, name, kind,           -- kind: http | function | other
  config_json,                            -- freeform; may include secret_ref string
  allowed_roles,                          -- jsonb string[] e.g. ["builder","developer","admin"]
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

No `credentials` table in M4 (YAGNI vault). Do not put real secrets in seed data.

Unique: `(workspace_id, name)` per asset table.

### 4.2 APIs

Base path prefix `/assets` (auth required).

| Method | Path | Min role |
|---|---|---|
| `GET` | `/assets/tools` | viewer+ |
| `POST` | `/assets/tools` | developer+ |
| `GET` | `/assets/tools/:id` | viewer+ |
| `PATCH` | `/assets/tools/:id` | developer+ |
| `DELETE` | `/assets/tools/:id` | developer+ |
| same pattern | `/assets/models`, `/assets/knowledge-bases` | same |

List tools further filters by `allowed_roles` containing caller role (or empty/missing = all roles in workspace).

Bodies: Zod-validated `{ name, kind?, config?, allowed_roles? }` etc. Return 404 if wrong workspace.

### 4.3 Seed samples

- Tool `demo_echo` (kind `function`, allowed_roles all editing roles)
- Model `demo_stub` (provider `stub`)
- Knowledge base `demo_kb`

Graph nodes may reference assets by id in `config` (`tool_id`, `model_id`, `knowledge_base_id`); publish gate verifies refs exist when those keys are present / required by type.

## 5. Publish gate

### 5.1 When

`POST /flows/:flowId/publish` runs gate **before** creating the immutable published version. Failure → `400` with structured body (no partial publish).

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

### 5.2 Checks

1. **`required_config`**
   - For each draft node, load `node_defs` by `type_key` (workspace).
   - If `config_schema` has JSON Schema `required: [...]`, ensure those keys exist and are non-empty (string/array/object rules: non-empty string; non-null).
   - Type-specific extras (hardcoded map, small):
     - `HTTP` → `url`
     - `Tool` → `tool_id` must exist in `tools` for workspace
     - `LLM` / `Agent` → `model_id` must exist in `models` when present in schema required or when key set
     - `KnowledgeRetrieve` → `knowledge_base_id` must exist when key set / required
   - Nodes with empty `config_schema.required` and no type extras pass.

2. **`successful_test_run`**
   - Draft `schema_hash` = `hashGraph(draft.graph)` (same as save).
   - Pass if there exists a `runs` row for this **flow** where:
     - `trigger = 'test'`
     - `status = 'succeeded'`
     - joined `flow_versions.schema_hash === draft.schema_hash`
   - **Bootstrap exception:** if `flows.publishedVersionId` is null (never published), this check is **skipped** (ok=true, message=`bootstrap_skip`). First publish only needs `required_config` (+ `role_nodes`). After that, every publish needs a matching successful test-run.

3. **`role_nodes`**
   - Every node type in draft must satisfy `roleAtLeast(publisher.role, node_def.minRole)`.
   - Unknown type (no node_def) → fail check.

### 5.3 Draft test-run (chicken-and-egg fix)

M2 published-only rule is **relaxed for developer+**:

- `POST /flows/:flowId/runs` body: `{ input: object, graph_source?: "published" | "draft" }`
- Default `graph_source = "published"` (backward compatible).
- `graph_source = "draft"`: only `developer` / `admin`; creates a run against the **current draft** `flow_versions` row (status remains `draft`; run still points at that version id). Executor receives that version’s `graph_json` unchanged.
- Builder requesting draft → `403`.
- Published path unchanged for builder+.

This lets a developer: edit draft → draft test-run → succeed → publish (gate sees matching hash).

## 6. Control-plane enforcement points

| Route / service | Change |
|---|---|
| `listNodeDefs` | Filter by caller role |
| `saveDraft` / `createFlow` / `publishFlow` | Require builder+ |
| `publishFlow` | Run gate; need `role` arg |
| `createTestRun` | Role checks + optional draft source |
| runs signal/state/breakpoints/cancel | Require builder+ |
| new assets routes | As §4.2 |
| `auth` | Optionally validate role ∈ known set |

Audit: existing `flow.publish` audit remains; on gate failure do **not** write publish audit. Optional `audit_logs` for asset CRUD (`asset.create` etc.) — nice-to-have, include if cheap.

## 7. Web UI (thin)

- **User switcher**: select among seeded user ids → sets client `X-User-Id` (localStorage ok).
- **Palette**: load `listNodeDefs()` (server-filtered); do not hardcode developer-only types for builders.
- **Assets panel**: list tools/models/KBs; developer+ can create/delete simple forms (name + JSON config).
- **Publish**: surface `publish_gate_failed.checks` in status/error UI; do not pretend success.
- No new design system; reuse existing toolbar/panel CSS patterns from M2/M3.

## 8. Migration & scripts

- Migration name exact: `0004_m4_roles_assets_gate`
- Adds `tools`, `models`, `knowledge_bases` tables
- Seed update: users + memberships + Code/Breakpoint min_role + sample assets; tighten some `config_schema.required` for HTTP/LLM where useful for demos
- Root script: `test:m4` → vitest `tests/m4-integration.test.ts` (pattern of `test:m3`)

## 9. Acceptance

1. Builder `GET /node-defs` omits `Code`; developer sees `Code`.
2. Viewer cannot `PUT` draft / `POST` publish / create run (403).
3. Developer can CRUD tools/models/knowledge_bases; builder GET-only for assets.
4. Publish with missing HTTP `url` → 400 `publish_gate_failed` / `required_config`.
5. After first publish, changing draft and publishing without a successful test-run on new hash → 400 `successful_test_run`.
6. Developer draft test-run then publish with matching hash → 200 published.
7. `pnpm test:m4` and existing `test:m2` / `test:m3` still green (M2 published default path unchanged for builder).

## 10. Approval

Approved for execution; implemented via `docs/superpowers/plans/2026-10-22-m4-roles-assets-publish-gate.md` (branch `feature/m4-roles-assets-publish-gate`).
