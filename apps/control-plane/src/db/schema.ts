import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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

export const flowVersions = pgTable("flow_versions", {
  id: text("id").primaryKey(),
  flowId: text("flow_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(), // draft | published | archived
  graphJson: jsonb("graph_json").notNull(),
  schemaHash: text("schema_hash").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
