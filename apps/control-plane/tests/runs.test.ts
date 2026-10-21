import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

const headers = {
  "X-User-Id": "u_dev",
  "Content-Type": "application/json",
};

const minimalGraph = {
  id: "tmp",
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
};

describe("runs API", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  async function createFlow(name: string): Promise<string> {
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    return id as string;
  }

  async function saveAndPublish(flowId: string): Promise<string> {
    const saved = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: minimalGraph }),
    });
    expect(saved.status).toBe(200);
    const pub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pub.status).toBe(200);
    const published = await pub.json();
    return published.versionId as string;
  }

  it("creates test run only against published version", async () => {
    const flowId = await createFlow(`m2-run-${Date.now()}`);
    const publishedVersionId = await saveAndPublish(flowId);

    const res = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { question: "hi" } }),
    });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.status).toBe("queued");
    expect(run.flowVersionId).toBe(publishedVersionId);
    expect(run.id).toMatch(/^run_/);

    const events = await app.request(`/runs/${run.id}/events`, { headers });
    expect(events.status).toBe(200);
    expect((await events.json()).events).toEqual([]);

    const got = await app.request(`/runs/${run.id}`, { headers });
    expect(got.status).toBe(200);
    const meta = await got.json();
    expect(meta.id).toBe(run.id);
    expect(meta.status).toBe("queued");
    expect(meta.trigger).toBe("test");
    expect(meta.inputJson).toEqual({ question: "hi" });

    const list = await app.request(`/flows/${flowId}/runs`, { headers });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.some((r: { id: string }) => r.id === run.id)).toBe(true);

    const { db } = await import("../src/db/client");
    const { auditLogs } = await import("../src/db/schema");
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, run.id),
          eq(auditLogs.action, "run.test_create"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]?.actor).toBe("u_dev");
  });

  it("rejects test run when nothing published", async () => {
    const draftOnlyFlowId = await createFlow(`m2-draft-only-${Date.now()}`);

    const res = await app.request(`/flows/${draftOnlyFlowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("cancels a queued run", async () => {
    const flowId = await createFlow(`m2-cancel-${Date.now()}`);
    await saveAndPublish(flowId);

    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { x: 1 } }),
    });
    expect(created.status).toBe(201);
    const run = await created.json();

    const cancel = await app.request(`/runs/${run.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancel.status).toBe(200);
    const cancelled = await cancel.json();
    expect(cancelled.status).toBe("cancel_requested");

    const got = await app.request(`/runs/${run.id}`, { headers });
    expect((await got.json()).status).toBe("cancel_requested");
  });
});
