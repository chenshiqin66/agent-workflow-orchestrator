import { describe, it, expect, beforeAll } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

const jsonHeaders = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

const tinyGraph = {
  id: "tmp",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "t", type: "Transform", config: { set: { a: 1 } }, ui: { x: 100, y: 0 } },
    { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
  ],
  edges: [
    {
      id: "e0",
      source: "s",
      sourceHandle: "out",
      target: "t",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e1",
      source: "t",
      sourceHandle: "out",
      target: "e",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

async function insertSucceededRunForHash(
  flowVersionId: string,
  createdBy = "u_dev",
): Promise<string> {
  const { db } = await import("../src/db/client");
  const { runs } = await import("../src/db/schema");
  const id = `run_tpl_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.insert(runs).values({
    id,
    flowVersionId,
    trigger: "test",
    status: "succeeded",
    inputJson: {},
    outputJson: {},
    createdBy,
    finishedAt: new Date(),
  });
  return id;
}

describe("templates API", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  it("viewer cannot create template", async () => {
    const res = await app.request("/templates", {
      method: "POST",
      headers: jsonHeaders("u_viewer"),
      body: JSON.stringify({ name: "x", flow_version_id: "fv_x" }),
    });
    expect(res.status).toBe(403);
  });

  it("developer creates template from published; builder clones", async () => {
    const createFlow = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({ name: `tpl_src_${Date.now()}` }),
    });
    expect(createFlow.status).toBe(201);
    const flow = (await createFlow.json()) as { id: string };

    const draft = await app.request(`/flows/${flow.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({ graph: tinyGraph }),
    });
    expect(draft.status).toBe(200);
    const draftBody = (await draft.json()) as { versionId: string; id?: string };
    const versionId =
      draftBody.versionId ??
      (await (async () => {
        const g = await app.request(`/flows/${flow.id}`, {
          headers: jsonHeaders("u_dev"),
        });
        const fj = (await g.json()) as { latestDraftVersionId: string };
        return fj.latestDraftVersionId;
      })());

    await insertSucceededRunForHash(versionId);

    const pub = await app.request(`/flows/${flow.id}/publish`, {
      method: "POST",
      headers: jsonHeaders("u_dev"),
    });
    expect(pub.status).toBe(200);
    const published = (await pub.json()) as { versionId: string };

    const tplName = `t1_${Date.now()}`;
    const createTpl = await app.request("/templates", {
      method: "POST",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({
        name: tplName,
        description: "from test",
        flow_version_id: published.versionId,
      }),
    });
    expect(createTpl.status).toBe(201);
    const tpl = (await createTpl.json()) as { id: string; name: string };
    expect(tpl.name).toBe(tplName);

    const list = await app.request("/templates", {
      headers: jsonHeaders("u_viewer"),
    });
    expect(list.status).toBe(200);
    const items = (await list.json()) as { id: string; name: string }[];
    expect(items.some((t) => t.id === tpl.id)).toBe(true);

    const cloneName = `from_tpl_${Date.now()}`;
    const clone = await app.request(`/templates/${tpl.id}/clone`, {
      method: "POST",
      headers: jsonHeaders("u_builder"),
      body: JSON.stringify({ project_id: "p_demo", name: cloneName }),
    });
    expect(clone.status).toBe(201);
    const cloned = (await clone.json()) as { id: string; name: string };
    expect(cloned.name).toBe(cloneName);

    const got = await app.request(`/flows/${cloned.id}`, {
      headers: jsonHeaders("u_builder"),
    });
    expect(got.status).toBe(200);
    const detail = (await got.json()) as {
      graph: { nodes: unknown[] };
    };
    expect(detail.graph.nodes.length).toBeGreaterThan(0);
  });

  it("duplicate template name returns 409", async () => {
    const createFlow = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({ name: `tpl_dup_src_${Date.now()}` }),
    });
    expect(createFlow.status).toBe(201);
    const flow = (await createFlow.json()) as { id: string };

    const draft = await app.request(`/flows/${flow.id}/draft`, {
      method: "PUT",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({ graph: tinyGraph }),
    });
    expect(draft.status).toBe(200);
    const draftBody = (await draft.json()) as { versionId: string; id?: string };
    const versionId =
      draftBody.versionId ??
      (await (async () => {
        const g = await app.request(`/flows/${flow.id}`, {
          headers: jsonHeaders("u_dev"),
        });
        const fj = (await g.json()) as { latestDraftVersionId: string };
        return fj.latestDraftVersionId;
      })());
    await insertSucceededRunForHash(versionId);

    const pub = await app.request(`/flows/${flow.id}/publish`, {
      method: "POST",
      headers: jsonHeaders("u_dev"),
    });
    expect(pub.status).toBe(200);
    const published = (await pub.json()) as { versionId: string };

    const tplName = `dup_${Date.now()}`;
    const first = await app.request("/templates", {
      method: "POST",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({
        name: tplName,
        flow_version_id: published.versionId,
      }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/templates", {
      method: "POST",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({
        name: tplName,
        flow_version_id: published.versionId,
      }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/already exists/i);
  });

  it("lists seeded demo template", async () => {
    const list = await app.request("/templates", {
      headers: jsonHeaders("u_viewer"),
    });
    expect(list.status).toBe(200);
    const items = (await list.json()) as { id: string }[];
    expect(items.some((t) => t.id === "tpl_demo_basic")).toBe(true);

    const detail = await app.request("/templates/tpl_demo_basic", {
      headers: jsonHeaders("u_viewer"),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { graph: { nodes: unknown[] } };
    expect(body.graph.nodes.length).toBeGreaterThan(0);
  });
});
