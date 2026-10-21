import { z } from "zod";
import { FlowGraphSchema } from "@awo/graph-schema";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "cancel_requested",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunEventTypeSchema = z.enum([
  "run_started",
  "run_finished",
  "node_started",
  "node_finished",
  "node_failed",
  "emit",
  "log",
  "breakpoint_hit",
  "waiting_signal",
  "signal_received",
  "state_patched",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const PauseKindSchema = z.enum(["breakpoint", "approval", "input"]);
export type PauseKind = z.infer<typeof PauseKindSchema>;

export const ResumeEdgeKindSchema = z.enum(["success", "failure", "default"]);
export type ResumeEdgeKind = z.infer<typeof ResumeEdgeKindSchema>;

export const CheckpointSchema = z.object({
  node_id: z.string().min(1),
  state: z.record(z.unknown()),
  pause_kind: PauseKindSchema,
  resume_edge_kind: ResumeEdgeKindSchema.optional(),
  pending_input: z.record(z.unknown()).optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const JobPayloadSchema = z.object({
  run_id: z.string().min(1),
  flow_version_id: z.string().min(1),
  graph: FlowGraphSchema,
  input: z.record(z.unknown()),
  callback_base_url: z.string().min(1),
  token: z.string().min(1),
  checkpoint: CheckpointSchema.optional(),
  breakpoints: z.array(z.string().min(1)).optional(),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export const SignalKindSchema = z.enum([
  "approve",
  "reject",
  "input",
  "resume",
]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const CallbackEventBodySchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  node_id: z.string().min(1).optional(),
  event_type: RunEventTypeSchema,
  payload: z.record(z.unknown()),
  ts: z.string().optional(),
});
export type CallbackEventBody = z.infer<typeof CallbackEventBodySchema>;

export function parseJobPayload(input: unknown): JobPayload {
  return JobPayloadSchema.parse(input);
}

export function parseCallbackEvent(input: unknown): CallbackEventBody {
  return CallbackEventBodySchema.parse(input);
}
