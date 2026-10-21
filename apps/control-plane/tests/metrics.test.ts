import { describe, it, expect, beforeAll } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

describe("metrics API", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  it("GET /metrics/workspace returns flows array", async () => {
    const res = await app.request("/metrics/workspace", {
      headers: { "X-User-Id": "u_viewer" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flows: unknown[];
      from: string;
      to: string;
    };
    expect(Array.isArray(body.flows)).toBe(true);
    expect(body.from).toBeTruthy();
    expect(body.to).toBeTruthy();
  });

  it("GET /metrics/flows/:id 404 for unknown", async () => {
    const res = await app.request("/metrics/flows/flow_does_not_exist", {
      headers: { "X-User-Id": "u_viewer" },
    });
    expect(res.status).toBe(404);
  });

  it("GET /metrics/flows/:id returns totals keys after inserting a run", async () => {
    // create a flow then insert a run against its draft version
    const create = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: {
        "X-User-Id": "u_dev",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: `metrics_${Date.now()}` }),
    });
    expect(create.status).toBe(201);
    const flow = (await create.json()) as { id: string };
    const got = await app.request(`/flows/${flow.id}`, {
      headers: { "X-User-Id": "u_dev" },
    });
    const detail = (await got.json()) as { latestDraftVersionId: string };
    const { db } = await import("../src/db/client");
    const { runs } = await import("../src/db/schema");
    const runId = `run_metrics_${crypto.randomUUID().replace(/-/g, "")}`;
    const started = new Date("2026-10-22T00:00:00Z");
    const finished = new Date("2026-10-22T00:00:03Z");
    await db.insert(runs).values({
      id: runId,
      flowVersionId: detail.latestDraftVersionId,
      trigger: "test",
      status: "succeeded",
      inputJson: {},
      outputJson: {},
      costTokens: 42,
      startedAt: started,
      finishedAt: finished,
      createdBy: "u_dev",
      createdAt: new Date(),
    });

    const res = await app.request(`/metrics/flows/${flow.id}`, {
      headers: { "X-User-Id": "u_viewer" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        runs: number;
        succeeded: number;
        success_rate: number;
        sum_cost_tokens: number;
        avg_latency_ms: number | null;
      };
      by_version: unknown[];
    };
    expect(body.totals.runs).toBeGreaterThanOrEqual(1);
    expect(body.totals.succeeded).toBeGreaterThanOrEqual(1);
    expect(body.totals.success_rate).toBeDefined();
    expect(body.totals.sum_cost_tokens).toBeGreaterThanOrEqual(42);
    expect(Array.isArray(body.by_version)).toBe(true);
  });
});
