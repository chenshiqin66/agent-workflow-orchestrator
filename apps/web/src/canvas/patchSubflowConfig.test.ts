import { describe, it, expect } from "vitest";
import { patchSubflowFlowVersionId } from "./patchSubflowConfig";
import type { FlowGraph } from "@awo/graph-schema";

const graph: FlowGraph = {
  id: "g",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    {
      id: "sf",
      type: "Subflow",
      config: { label: "子流程", flow_version_id: "" },
      ui: { x: 40, y: 0 },
    },
    { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
  ],
  edges: [],
};

describe("patchSubflowFlowVersionId", () => {
  it("writes flow_version_id on Subflow node", () => {
    const out = patchSubflowFlowVersionId(graph, "sf", "fv_published_1");
    const node = out.nodes.find((n) => n.id === "sf");
    expect(node?.config.flow_version_id).toBe("fv_published_1");
    expect(node?.config.label).toBe("子流程");
  });

  it("ignores non-Subflow ids", () => {
    const out = patchSubflowFlowVersionId(graph, "s", "fv_x");
    expect(out).toBe(graph);
  });
});
