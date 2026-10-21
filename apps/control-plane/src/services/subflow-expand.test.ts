import { describe, it, expect } from "vitest";
import { expandSubflows, SubflowExpandError } from "./subflow-expand";
import type { FlowGraph } from "@awo/graph-schema";

const child: FlowGraph = {
  id: "fv_child",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "t", type: "Transform", config: { set: { k: 1 } }, ui: { x: 40, y: 0 } },
    { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "s", sourceHandle: "out", target: "t", targetHandle: "in", kind: "default", label: "" },
    { id: "e2", source: "t", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
  ],
};

const parent: FlowGraph = {
  id: "fv_parent",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "ps", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "sf", type: "Subflow", config: { flow_version_id: "fv_child" }, ui: { x: 40, y: 0 } },
    { id: "pe", type: "End", config: {}, ui: { x: 80, y: 0 } },
  ],
  edges: [
    { id: "p1", source: "ps", sourceHandle: "out", target: "sf", targetHandle: "in", kind: "default", label: "" },
    { id: "p2", source: "sf", sourceHandle: "out", target: "pe", targetHandle: "in", kind: "default", label: "" },
  ],
};

describe("expandSubflows", () => {
  it("inlines child with prefixed ids", async () => {
    const out = await expandSubflows(parent, {
      resolvePublished: async (id) =>
        id === "fv_child"
          ? { graph: child, status: "published", workspaceOk: true }
          : null,
    });
    expect(out.nodes.some((n) => n.type === "Subflow")).toBe(false);
    expect(out.nodes.map((n) => n.id)).toContain("sf__s");
    expect(out.nodes.map((n) => n.id)).toContain("sf__t");
    expect(out.edges.some((e) => e.target === "sf__s")).toBe(true);
    expect(out.edges.some((e) => e.source === "sf__e")).toBe(true);
  });

  it("rejects cycles", async () => {
    await expect(
      expandSubflows(parent, {
        resolvePublished: async () => ({
          graph: {
            ...child,
            nodes: [
              ...child.nodes,
              { id: "loop", type: "Subflow", config: { flow_version_id: "fv_child" }, ui: { x: 1, y: 1 } },
            ],
          },
          status: "published",
          workspaceOk: true,
        }),
      }),
    ).rejects.toMatchObject({ code: "subflow_cycle" });
  });

  it("rejects missing version", async () => {
    await expect(
      expandSubflows(parent, { resolvePublished: async () => null }),
    ).rejects.toBeInstanceOf(SubflowExpandError);
  });

  it("expands nested Subflow parent→mid→leaf with prefixed ids", async () => {
    const leaf: FlowGraph = {
      id: "fv_leaf",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "t", type: "Transform", config: { set: { nested: true } }, ui: { x: 40, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "s", sourceHandle: "out", target: "t", targetHandle: "in", kind: "default", label: "" },
        { id: "e2", source: "t", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
      ],
    };
    const mid: FlowGraph = {
      id: "fv_mid",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "sf", type: "Subflow", config: { flow_version_id: "fv_leaf" }, ui: { x: 40, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 80, y: 0 } },
      ],
      edges: [
        { id: "m1", source: "s", sourceHandle: "out", target: "sf", targetHandle: "in", kind: "default", label: "" },
        { id: "m2", source: "sf", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
      ],
    };
    const nestedParent: FlowGraph = {
      id: "fv_parent_nested",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "ps", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "sf", type: "Subflow", config: { flow_version_id: "fv_mid" }, ui: { x: 40, y: 0 } },
        { id: "pe", type: "End", config: {}, ui: { x: 80, y: 0 } },
      ],
      edges: [
        { id: "p1", source: "ps", sourceHandle: "out", target: "sf", targetHandle: "in", kind: "default", label: "" },
        { id: "p2", source: "sf", sourceHandle: "out", target: "pe", targetHandle: "in", kind: "default", label: "" },
      ],
    };
    const graphs: Record<string, FlowGraph> = {
      fv_mid: mid,
      fv_leaf: leaf,
    };
    const out = await expandSubflows(nestedParent, {
      resolvePublished: async (id) =>
        graphs[id]
          ? { graph: graphs[id]!, status: "published", workspaceOk: true }
          : null,
    });
    expect(out.nodes.some((n) => n.type === "Subflow")).toBe(false);
    const ids = out.nodes.map((n) => n.id);
    expect(ids).toContain("sf__s");
    expect(ids).toContain("sf__e");
    expect(ids).toContain("sf__sf__t");
    expect(out.edges.some((e) => e.target === "sf__s")).toBe(true);
    expect(out.edges.some((e) => e.source === "sf__e")).toBe(true);
    // mid's Subflow rewired to nested leaf Start/End under double prefix
    expect(out.edges.some((e) => e.target === "sf__sf__s")).toBe(true);
    expect(out.edges.some((e) => e.source === "sf__sf__e")).toBe(true);
  });

  it("rejects depth exceeded", async () => {
    const nested: FlowGraph = {
      id: "fv_d1",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "sf", type: "Subflow", config: { flow_version_id: "fv_d2" }, ui: { x: 1, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 2, y: 0 } },
      ],
      edges: [
        { id: "a", source: "s", sourceHandle: "out", target: "sf", targetHandle: "in", kind: "default", label: "" },
        { id: "b", source: "sf", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
      ],
    };
    const leaf: FlowGraph = {
      id: "fv_leaf",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 1, y: 0 } },
      ],
      edges: [
        { id: "a", source: "s", sourceHandle: "out", target: "e", targetHandle: "in", kind: "default", label: "" },
      ],
    };
    const graphs: Record<string, FlowGraph> = {
      fv_d2: {
        ...nested,
        id: "fv_d2",
        nodes: nested.nodes.map((n) =>
          n.type === "Subflow" ? { ...n, config: { flow_version_id: "fv_d3" } } : n,
        ),
      },
      fv_d3: {
        ...nested,
        id: "fv_d3",
        nodes: nested.nodes.map((n) =>
          n.type === "Subflow" ? { ...n, config: { flow_version_id: "fv_d4" } } : n,
        ),
      },
      fv_d4: {
        ...nested,
        id: "fv_d4",
        nodes: nested.nodes.map((n) =>
          n.type === "Subflow" ? { ...n, config: { flow_version_id: "fv_leaf" } } : n,
        ),
      },
      fv_leaf: leaf,
    };
    await expect(
      expandSubflows(
        {
          ...parent,
          nodes: parent.nodes.map((n) =>
            n.type === "Subflow" ? { ...n, config: { flow_version_id: "fv_d2" } } : n,
          ),
        },
        {
          maxDepth: 3,
          resolvePublished: async (id) =>
            graphs[id]
              ? { graph: graphs[id]!, status: "published", workspaceOk: true }
              : null,
        },
      ),
    ).rejects.toMatchObject({ code: "subflow_depth_exceeded" });
  });

  it("rejects missing config", async () => {
    const bad: FlowGraph = {
      ...parent,
      nodes: parent.nodes.map((n) =>
        n.type === "Subflow" ? { ...n, config: {} } : n,
      ),
    };
    await expect(
      expandSubflows(bad, { resolvePublished: async () => null }),
    ).rejects.toMatchObject({ code: "subflow_missing_config" });
  });
});
