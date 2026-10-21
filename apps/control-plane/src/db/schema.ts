import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(), // admin | developer | builder | viewer
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
});

export const flows = pgTable("flows", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  latestDraftVersionId: text("latest_draft_version_id"),
  publishedVersionId: text("published_version_id"),
});

export const flowVersions = pgTable(
  "flow_versions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(), // draft | published | archived
    graphJson: jsonb("graph_json").notNull(),
    schemaHash: text("schema_hash").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("flow_versions_flow_id_version_unique").on(t.flowId, t.version)],
);

export const nodeDefs = pgTable("node_defs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  typeKey: text("type_key").notNull(),
  category: text("category").notNull(),
  configSchema: jsonb("config_schema").notNull(),
  uiMeta: jsonb("ui_meta").notNull(),
  minRole: text("min_role").notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  diffJson: jsonb("diff_json"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});

/** M2: test/prod/api runs against a flow_version */
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  flowVersionId: text("flow_version_id").notNull(),
  trigger: text("trigger").notNull(), // test | prod | api
  status: text("status").notNull(),
  inputJson: jsonb("input_json").notNull(),
  outputJson: jsonb("output_json"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  costTokens: integer("cost_tokens").default(0),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** M3: executor checkpoint while paused */
  checkpointJson: jsonb("checkpoint_json"),
  /** M3: breakpoint | approval | input */
  pauseReason: text("pause_reason"),
});

export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    nodeId: text("node_id"),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("run_events_run_id_seq_unique").on(t.runId, t.seq)],
);

/** M3: per-run dynamic breakpoints */
export const runBreakpoints = pgTable(
  "run_breakpoints",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    active: integer("active").notNull().default(1), // 1=active, 0=inactive
  },
  (t) => [
    unique("run_breakpoints_run_id_node_id_unique").on(t.runId, t.nodeId),
  ],
);

/** M3: user signals (approve/reject/input/resume) against a paused run */
export const runSignals = pgTable("run_signals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  /** approval | input | resume — approve/reject stored under approval + payload */
  kind: text("kind").notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  /** pending | consumed | rejected */
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** M4: workspace tool registry */
export const tools = pgTable(
  "tools",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    configJson: jsonb("config_json").notNull(),
    allowedRoles: jsonb("allowed_roles").notNull(), // string[]
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("tools_workspace_name").on(t.workspaceId, t.name)],
);

/** M4: workspace model registry */
export const models = pgTable(
  "models",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    configJson: jsonb("config_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("models_workspace_name").on(t.workspaceId, t.name)],
);

/** M4: workspace knowledge base registry */
export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    configJson: jsonb("config_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("knowledge_bases_workspace_name").on(t.workspaceId, t.name)],
);
