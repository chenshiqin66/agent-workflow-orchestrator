import { describe, it, expect } from "vitest";
import type { FlowGraph } from "@awo/graph-schema";
import { toXyflow, fromXyflow } from "./graph-adapter";

const sampleGraph: FlowGraph = {
  id: "tmp",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "b", type: "Branch", config: {}, ui: { x: 160, y: 0, variant: "decision" } },
    { id: "ok", type: "End", config: {}, ui: { x: 320, y: -40 } },
    { id: "bad", type: "End", config: {}, ui: { x: 320, y: 40 } },
  ],
  edges: [
    {
      id: "e0",
      source: "s",
      sourceHandle: "out",
      target: "b",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e1",
      source: "b",
      sourceHandle: "success",
      target: "ok",
      targetHandle: "in",
      kind: "success",
      label: "查询成功",
    },
    {
      id: "e2",
      source: "b",
      sourceHandle: "failure",
      target: "bad",
      targetHandle: "in",
      kind: "failure",
      label: "查询失败",
    },
  ],
};

describe("graph-adapter", () => {
  it("round-trips handles and edge kinds", () => {
    const { nodes, edges } = toXyflow(sampleGraph);
    expect(edges.find((e) => e.id === "e1")?.style?.stroke).toBeDefined();
    const back = fromXyflow(nodes, edges, sampleGraph.id);
    expect(back.edges.map((e) => e.kind).sort()).toEqual(["default", "failure", "success"]);
  });

  it("maps Branch to decision node type and preserves positions", () => {
    const { nodes } = toXyflow(sampleGraph);
    const branch = nodes.find((n) => n.id === "b");
    expect(branch?.type).toBe("decision");
    expect(branch?.position).toEqual({ x: 160, y: 0 });
    expect(nodes.find((n) => n.id === "s")?.type).toBe("base");
  });

  it("applies success/failure stroke colors", () => {
    const { edges } = toXyflow(sampleGraph);
    expect(edges.find((e) => e.id === "e1")?.style?.stroke).toBe("#3b82f6");
    expect(edges.find((e) => e.id === "e2")?.style?.stroke).toBe("#ef4444");
    expect(edges.find((e) => e.id === "e1")?.data).toMatchObject({
      kind: "success",
      label: "查询成功",
    });
  });

  it("round-trips node config and state_schema", () => {
    const { nodes, edges } = toXyflow(sampleGraph);
    const back = fromXyflow(nodes, edges, sampleGraph.id, sampleGraph.state_schema);
    expect(back.id).toBe("tmp");
    expect(back.nodes).toHaveLength(4);
    expect(back.nodes.find((n) => n.id === "b")?.type).toBe("Branch");
    expect(back.edges.find((e) => e.id === "e1")?.sourceHandle).toBe("success");
    expect(back.edges.find((e) => e.id === "e2")?.label).toBe("查询失败");
  });

  it("fails closed when graphType is missing on a non-decision node", () => {
    const { nodes, edges } = toXyflow(sampleGraph);
    const broken = nodes.map((n) =>
      n.id === "s" ? { ...n, data: { label: "Start" } } : n,
    );
    expect(() => fromXyflow(broken, edges, sampleGraph.id)).toThrow(
      /missing data\.graphType/,
    );
  });

  it("maps decision XYFlow type to Branch when graphType omitted", () => {
    const { nodes, edges } = toXyflow(sampleGraph);
    const withoutType = nodes.map((n) =>
      n.id === "b"
        ? { ...n, data: { label: "判断", config: {}, variant: "decision" } }
        : n,
    );
    const back = fromXyflow(withoutType, edges, sampleGraph.id);
    expect(back.nodes.find((n) => n.id === "b")?.type).toBe("Branch");
  });
});
