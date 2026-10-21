import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";

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

    const got = await app.request(`/flows/${id}`, { headers });
    expect(got.status).toBe(200);
    const flowBody = await got.json();
    expect(flowBody.id).toBe(id);
    expect(flowBody.name).toBe("客服流水线");
    expect(flowBody.latestDraftVersionId).toBeTruthy();
    expect(flowBody.draft?.status).toBe("draft");
    expect(flowBody.graph).toMatchObject({ nodes: [], edges: [] });

    const nodeDefsRes = await app.request("/node-defs", { headers });
    expect(nodeDefsRes.status).toBe(200);
    const defs = await nodeDefsRes.json();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThanOrEqual(5);
    const typeKeys = defs.map((d: { typeKey: string }) => d.typeKey);
    for (const key of ["Start", "End", "Branch", "HTTP", "LLM"]) {
      expect(typeKeys).toContain(key);
    }

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

    const { db } = await import("../src/db/client");
    const { auditLogs } = await import("../src/db/schema");
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, id), eq(auditLogs.action, "flow.publish")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]?.actor).toBe("u_dev");
    expect(audits[0]?.resourceType).toBe("flow");
    expect(audits[0]?.diffJson).toMatchObject({
      publishedVersionId: published.versionId,
      version: published.version,
      schemaHash: published.schemaHash,
    });

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
