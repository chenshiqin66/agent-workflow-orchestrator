import { describe, it, expect } from "vitest";
import { parseJobPayload, parseCallbackEvent, RunStatusSchema } from "./index";

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
