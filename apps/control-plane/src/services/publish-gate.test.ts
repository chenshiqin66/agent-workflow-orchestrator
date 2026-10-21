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

describe("evaluatePublishGate subflow_refs", () => {
  it("fails subflow_refs for missing flow_version_id target", async () => {
    const { evaluatePublishGate } = await import("./publish-gate");
    const result = await evaluatePublishGate({
      workspaceId: "ws_demo",
      flowId: "flow_x",
      draftGraph: {
        id: "fv",
        state_schema: { type: "object", properties: {} },
        nodes: [
          { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
          {
            id: "sf",
            type: "Subflow",
            config: { flow_version_id: "fv_missing_xyz" },
            ui: { x: 40, y: 0 },
          },
          { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
        ],
        edges: [
          {
            id: "e0",
            source: "s",
            sourceHandle: "out",
            target: "sf",
            targetHandle: "in",
            kind: "default",
            label: "",
          },
          {
            id: "e1",
            source: "sf",
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
    expect(result.ok).toBe(false);
    const sf = result.checks.find((c) => c.id === "subflow_refs");
    expect(sf?.ok).toBe(false);
    expect(sf?.message).toMatch(/subflow_/);
  });

  it("passes subflow_refs when Subflow points at published child", async () => {
    // Arrange: publish a tiny child via DB + bootstrap gate path through API would be heavy;
    // insert published version rows directly for gate unit test.
    const { db } = await import("../db/client");
    const { flows, flowVersions } = await import("../db/schema");
    const { hashGraph } = await import("@awo/graph-schema");
    const childGraph = {
      id: "fv_gate_child",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 1, y: 0 } },
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
    };
    const flowId = `flow_gate_child_${Date.now()}`;
    const fvId = `fv_gate_child_${Date.now()}`;
    childGraph.id = fvId;
    await db.insert(flows).values({
      id: flowId,
      projectId: "p_demo",
      name: "gate child",
      latestDraftVersionId: null,
      publishedVersionId: fvId,
    });
    await db.insert(flowVersions).values({
      id: fvId,
      flowId,
      version: 1,
      status: "published",
      graphJson: childGraph,
      schemaHash: hashGraph(childGraph as never),
      createdBy: "u_dev",
    });

    const { evaluatePublishGate } = await import("./publish-gate");
    const result = await evaluatePublishGate({
      workspaceId: "ws_demo",
      flowId: "flow_parent_gate",
      draftGraph: {
        id: "fv_parent",
        state_schema: { type: "object", properties: {} },
        nodes: [
          { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
          {
            id: "sf",
            type: "Subflow",
            config: { flow_version_id: fvId },
            ui: { x: 40, y: 0 },
          },
          { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
        ],
        edges: [
          {
            id: "e0",
            source: "s",
            sourceHandle: "out",
            target: "sf",
            targetHandle: "in",
            kind: "default",
            label: "",
          },
          {
            id: "e1",
            source: "sf",
            sourceHandle: "out",
            target: "e",
            targetHandle: "in",
            kind: "default",
            label: "",
          },
        ],
      },
      draftSchemaHash: "abc",
      publisherRole: "builder",
      publishedVersionId: null,
    });
    expect(result.checks.find((c) => c.id === "subflow_refs")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});
