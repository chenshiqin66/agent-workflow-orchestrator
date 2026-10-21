import { describe, it, expect, beforeAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("flows API", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  it("creates flow, saves draft, publishes immutable version", async () => {
    const headers = { "X-User-Id": "u_dev", "Content-Type": "application/json" };
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "客服流水线" }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();

    const graph = {
      id: "tmp",
      state_schema: { type: "object", properties: {} },
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        { id: "b", type: "Branch", config: {}, ui: { x: 160, y: 0, variant: "decision" } },
        { id: "ok", type: "End", config: {}, ui: { x: 320, y: -40 } },
        { id: "bad", type: "End", config: {}, ui: { x: 320, y: 40 } },
      ],
      edges: [
        { id: "e0", source: "s", sourceHandle: "out", target: "b", targetHandle: "in", kind: "default", label: "" },
        { id: "e1", source: "b", sourceHandle: "success", target: "ok", targetHandle: "in", kind: "success", label: "查询成功" },
        { id: "e2", source: "b", sourceHandle: "failure", target: "bad", targetHandle: "in", kind: "failure", label: "查询失败" },
      ],
    };

    const saved = await app.request(`/flows/${id}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph }),
    });
    expect(saved.status).toBe(200);
    const draft = await saved.json();
    expect(draft.schemaHash).toMatch(/^[a-f0-9]{64}$/);

    const pub = await app.request(`/flows/${id}/publish`, { method: "POST", headers });
    expect(pub.status).toBe(200);
    const published = await pub.json();
    expect(published.status).toBe("published");

    // mutate published row must not be possible via draft overwrite of same version id
    const again = await app.request(`/flows/${id}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: { ...graph, nodes: graph.nodes.slice(0, 1) } }),
    });
    expect(again.status).toBe(200);
    const draft2 = await again.json();
    expect(draft2.versionId).not.toBe(published.versionId);
  });
});
