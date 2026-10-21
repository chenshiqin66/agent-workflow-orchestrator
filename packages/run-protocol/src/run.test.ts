import { describe, it, expect } from "vitest";
import {
  RunStatusSchema,
  RunEventTypeSchema,
  CheckpointSchema,
  parseJobPayload,
  parseCallbackEvent,
} from "./index";

describe("run-protocol", () => {
  it("parses a minimal job payload", () => {
    const job = parseJobPayload({
      run_id: "run_1",
      flow_version_id: "fv_1",
      graph: {
        id: "fv_1",
        state_schema: { type: "object", properties: {} },
        nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
        edges: [],
      },
      input: { question: "hello" },
      callback_base_url: "http://localhost:8787",
      token: "secret",
    });
    expect(job.run_id).toBe("run_1");
  });

  it("rejects unknown run status", () => {
    expect(() => RunStatusSchema.parse("flying")).toThrow();
  });

  it("parses callback event", () => {
    const ev = parseCallbackEvent({
      event_type: "node_finished",
      node_id: "s",
      payload: { output: {}, duration_ms: 3 },
    });
    expect(ev.event_type).toBe("node_finished");
  });
});

describe("run-protocol M3", () => {
  it("accepts paused status", () => {
    expect(RunStatusSchema.parse("paused")).toBe("paused");
  });

  it("accepts new event types", () => {
    for (const t of [
      "breakpoint_hit",
      "waiting_signal",
      "signal_received",
      "state_patched",
    ] as const) {
      expect(RunEventTypeSchema.parse(t)).toBe(t);
    }
  });

  it("parses job with checkpoint and breakpoints", () => {
    const job = parseJobPayload({
      run_id: "run_1",
      flow_version_id: "fv_1",
      graph: {
        id: "fv_1",
        state_schema: { type: "object", properties: {} },
        nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
        edges: [],
      },
      input: {},
      callback_base_url: "http://localhost:8787",
      token: "secret",
      breakpoints: ["n_transform"],
      checkpoint: {
        node_id: "n_transform",
        state: { flag: true },
        pause_kind: "breakpoint",
      },
    });
    expect(job.breakpoints).toEqual(["n_transform"]);
    expect(job.checkpoint?.pause_kind).toBe("breakpoint");
  });

  it("parses breakpoint_hit callback with checkpoint payload", () => {
    const ev = parseCallbackEvent({
      event_type: "breakpoint_hit",
      node_id: "n_transform",
      payload: {
        checkpoint: {
          node_id: "n_transform",
          state: { a: 1 },
          pause_kind: "breakpoint",
        },
      },
    });
    expect(ev.event_type).toBe("breakpoint_hit");
    expect(CheckpointSchema.parse(ev.payload.checkpoint).node_id).toBe(
      "n_transform",
    );
  });
});
