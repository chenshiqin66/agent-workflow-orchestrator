CREATE TABLE IF NOT EXISTS "flow_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "graph_json" jsonb NOT NULL,
  "source_flow_version_id" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flow_templates_workspace_name"
  ON "flow_templates" ("workspace_id", "name");
