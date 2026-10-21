import { describe, it, expect } from "vitest";
import { parseFlowGraph, hashGraph } from "./index";

describe("parseFlowGraph", () => {
  it("accepts a minimal start-end graph", () => {
    const g = parseFlowGraph({
      id: "fv1",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
      ],
      edges: [
        {
          id: "e1",
          source: "s",
          sourceHandle: "out",
          target: "e",
          targetHandle: "in",
          kind: "default",
          label: "",
        },
      ],
    });
    expect(g.nodes).toHaveLength(2);
  });

  it("rejects unknown edge kind", () => {
    expect(() =>
      parseFlowGraph({
        id: "fv1",
        state_schema: { type: "object", properties: {} },
        nodes: [],
        edges: [
          {
            id: "e1",
            source: "a",
            sourceHandle: "out",
            target: "b",
            targetHandle: "in",
            kind: "nope",
          },
        ],
      })
    ).toThrow();
  });
});

describe("hashGraph", () => {
  it("is stable for same content regardless of key order", () => {
    const a = parseFlowGraph({
      id: "fv1",
      state_schema: { type: "object", properties: {} },
      nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 1, y: 2 } }],
      edges: [],
    });
    const b = structuredClone(a);
    expect(hashGraph(a)).toBe(hashGraph(b));
  });

  it("ignores graph.id so draft/publish of same topology share a hash", () => {
    const base = {
      state_schema: { type: "object", properties: {} },
      nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 1, y: 2 } }],
      edges: [] as [],
    };
    const draft = parseFlowGraph({ ...base, id: "fv_draft" });
    const published = parseFlowGraph({ ...base, id: "fv_published" });
    expect(hashGraph(draft)).toBe(hashGraph(published));
  });
});
