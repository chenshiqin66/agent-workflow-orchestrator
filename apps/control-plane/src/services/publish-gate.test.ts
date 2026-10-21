import { describe, it, expect } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

describe("evaluatePublishGate", () => {
  it("fails required_config when HTTP node missing url", async () => {
    const { evaluatePublishGate } = await import("./publish-gate");
    const result = await evaluatePublishGate({
      workspaceId: "ws_demo",
      flowId: "flow_x",
      draftGraph: {
        id: "fv",
        state_schema: { type: "object", properties: {} },
        nodes: [
          { id: "n1", type: "HTTP", config: {}, ui: { x: 0, y: 0 } },
          { id: "n2", type: "End", config: {}, ui: { x: 1, y: 0 } },
        ],
        edges: [],
      },
      draftSchemaHash: "deadbeef",
      publisherRole: "builder",
      publishedVersionId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "required_config")?.ok).toBe(false);
  });

  it("skips successful_test_run on bootstrap", async () => {
    const { evaluatePublishGate } = await import("./publish-gate");
    const result = await evaluatePublishGate({
      workspaceId: "ws_demo",
      flowId: "flow_x",
      draftGraph: {
        id: "fv",
        state_schema: { type: "object", properties: {} },
        nodes: [
          { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
          { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
        ],
        edges: [
          {
            id: "e0",
            source: "s",
            sourceHandle: "out",
            target: "e",
            targetHandle: "in",
            kind: "default",
            label: "",
          },
        ],
      },
      draftSchemaHash: "deadbeef",
      publisherRole: "builder",
      publishedVersionId: null,
    });
    const tr = result.checks.find((c) => c.id === "successful_test_run");
    expect(tr?.ok).toBe(true);
    expect(tr?.message).toMatch(/bootstrap/i);
    expect(result.ok).toBe(true);
  });
});
