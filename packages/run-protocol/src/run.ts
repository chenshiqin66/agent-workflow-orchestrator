import { z } from "zod";
import { FlowGraphSchema } from "@awo/graph-schema";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
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
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const JobPayloadSchema = z.object({
  run_id: z.string().min(1),
  flow_version_id: z.string().min(1),
  graph: FlowGraphSchema,
  input: z.record(z.unknown()),
  callback_base_url: z.string().min(1),
  token: z.string().min(1),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

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
