ALTER TABLE "runs" ADD COLUMN "checkpoint_json" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pause_reason" text;
--> statement-breakpoint
CREATE TABLE "run_breakpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "run_breakpoints_run_id_node_id_unique" UNIQUE("run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "run_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
