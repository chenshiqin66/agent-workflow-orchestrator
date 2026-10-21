CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_version_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"input_json" jsonb NOT NULL,
	"output_json" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cost_tokens" integer DEFAULT 0,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"node_id" text,
	"event_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_unique" UNIQUE("run_id","seq")
);
