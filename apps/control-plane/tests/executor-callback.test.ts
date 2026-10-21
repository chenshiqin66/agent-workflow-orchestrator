import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

process.env.EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN ?? "test-executor-token";
process.env.EXECUTOR_URL =
  process.env.EXECUTOR_URL ?? "http://127.0.0.1:8790";
process.env.CALLBACK_BASE_URL =
  process.env.CALLBACK_BASE_URL ?? "http://127.0.0.1:8787";

const userHeaders = {
  "X-User-Id": "u_dev",
  "Content-Type": "application/json",
};

const executorHeaders = {
  "X-Executor-Token": process.env.EXECUTOR_TOKEN!,
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

describe("executor callbacks + dispatch", () => {
  let app: { request: typeof import("../src/index").app.request };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("../src/index");
    app = mod.app;
  });

  afterEach(() => {
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
  });

  async function createPublishedRun(): Promise<{ runId: string; flowId: string }> {
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ name: `m2-cb-${Date.now()}-${Math.random()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = await created.json();

    const saved = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers: userHeaders,
      body: JSON.stringify({ graph: minimalGraph }),
    });
    expect(saved.status).toBe(200);

    const pub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: userHeaders,
    });
    expect(pub.status).toBe(200);

    const res = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ input: { question: "hi" } }),
    });
    expect(res.status).toBe(201);
    const run = await res.json();
    return { runId: run.id as string, flowId: flowId as string };
  }

  it("rejects forged executor token", async () => {
    const { runId } = await createPublishedRun();

    const bad = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: {
        "X-Executor-Token": "forged-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "run_started",
        payload: {},
      }),
    });
    expect(bad.status).toBe(401);

    const badStatus = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: {
        "X-Executor-Token": "forged-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "running" }),
    });
    expect(badStatus.status).toBe(401);
  });

  it("rejects missing executor token", async () => {
    const { runId } = await createPublishedRun();

    const res = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "log", payload: { msg: "x" } }),
    });
    expect(res.status).toBe(401);
  });

  it("appends events with sequential seq and transitions status", async () => {
    const { runId } = await createPublishedRun();

    const ev1 = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "run_started",
        payload: {},
      }),
    });
    expect(ev1.status).toBe(201);
    const e1 = await ev1.json();
    expect(e1.seq).toBe(1);
    expect(e1.eventType).toBe("run_started");

    const stRunning = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({ status: "running" }),
    });
    expect(stRunning.status).toBe(200);
    expect((await stRunning.json()).status).toBe("running");

    const ev2 = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "node_started",
        node_id: "s",
        payload: {},
      }),
    });
    expect(ev2.status).toBe(201);
    expect((await ev2.json()).seq).toBe(2);

    const ev3 = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "node_finished",
        node_id: "s",
        payload: { duration_ms: 1 },
      }),
    });
    expect(ev3.status).toBe(201);
    expect((await ev3.json()).seq).toBe(3);

    const stOk = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        status: "succeeded",
        output: { answer: 42 },
      }),
    });
    expect(stOk.status).toBe(200);

    const got = await app.request(`/runs/${runId}`, { headers: userHeaders });
    expect(got.status).toBe(200);
    const meta = await got.json();
    expect(meta.status).toBe("succeeded");
    expect(meta.outputJson).toEqual({ answer: 42 });
    expect(meta.startedAt).toBeTruthy();
    expect(meta.finishedAt).toBeTruthy();

    const events = await app.request(`/runs/${runId}/events`, {
      headers: userHeaders,
    });
    const { events: list } = await events.json();
    expect(list.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
  });

  it("dispatches job payload to EXECUTOR_URL on test-run create", async () => {
    fetchMock.mockClear();
    const { runId } = await createPublishedRun();

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8790/v1/jobs");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.run_id).toBe(runId);
    expect(body.token).toBe(process.env.EXECUTOR_TOKEN);
    expect(body.callback_base_url).toBe("http://127.0.0.1:8787");
    expect(body.graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(body.input).toEqual({ question: "hi" });
  });

  it("marks run failed when executor push fails", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("ECONNREFUSED");
    });

    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ name: `m2-fail-push-${Date.now()}` }),
    });
    const { id: flowId } = await created.json();
    await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers: userHeaders,
      body: JSON.stringify({ graph: minimalGraph }),
    });
    await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: userHeaders,
    });

    const res = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ input: { x: 1 } }),
    });
    expect(res.status).toBe(201);
    const run = await res.json();
    // Create response must reflect post-dispatch status (not stale "queued")
    expect(run.status).toBe("failed");

    const got = await app.request(`/runs/${run.id}`, { headers: userHeaders });
    const meta = await got.json();
    expect(meta.status).toBe("failed");
    expect(meta.errorMessage).toMatch(/executor|ECONNREFUSED|dispatch/i);

    const events = await app.request(`/runs/${run.id}/events`, {
      headers: userHeaders,
    });
    const { events: list } = await events.json();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].eventType).toMatch(/log|run_finished|node_failed/);
  });

  it("marks run failed when EXECUTOR_TOKEN is unset", async () => {
    const prev = process.env.EXECUTOR_TOKEN;
    delete process.env.EXECUTOR_TOKEN;
    try {
      const created = await app.request("/projects/p_demo/flows", {
        method: "POST",
        headers: userHeaders,
        body: JSON.stringify({ name: `m2-no-token-${Date.now()}` }),
      });
      const { id: flowId } = await created.json();
      await app.request(`/flows/${flowId}/draft`, {
        method: "PUT",
        headers: userHeaders,
        body: JSON.stringify({ graph: minimalGraph }),
      });
      await app.request(`/flows/${flowId}/publish`, {
        method: "POST",
        headers: userHeaders,
      });

      const res = await app.request(`/flows/${flowId}/test-runs`, {
        method: "POST",
        headers: userHeaders,
        body: JSON.stringify({ input: { x: 1 } }),
      });
      expect(res.status).toBe(201);
      const run = await res.json();
      expect(run.status).toBe("failed");

      const got = await app.request(`/runs/${run.id}`, { headers: userHeaders });
      const meta = await got.json();
      expect(meta.status).toBe("failed");
      expect(meta.errorMessage).toMatch(/EXECUTOR_TOKEN/);
    } finally {
      if (prev === undefined) {
        delete process.env.EXECUTOR_TOKEN;
      } else {
        process.env.EXECUTOR_TOKEN = prev;
      }
    }
  });

  it("pause on breakpoint_hit stores checkpoint; resume job includes checkpoint+breakpoints", async () => {
    const { runId } = await createPublishedRun();

    const putBp = await app.request(`/runs/${runId}/breakpoints`, {
      method: "PUT",
      headers: userHeaders,
      body: JSON.stringify({ node_ids: ["n_transform", "n_other"] }),
    });
    expect(putBp.status).toBe(200);

    const pause = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "breakpoint_hit",
        node_id: "n_transform",
        payload: {
          checkpoint: {
            node_id: "n_transform",
            state: { flag: true },
            pause_kind: "breakpoint",
          },
        },
      }),
    });
    expect(pause.status).toBe(201);

    const got = await app.request(`/runs/${runId}`, { headers: userHeaders });
    const meta = await got.json();
    expect(meta.status).toBe("paused");
    expect(meta.pauseReason).toBe("breakpoint");
    expect(meta.checkpoint.node_id).toBe("n_transform");

    fetchMock.mockClear();
    const sig = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ kind: "resume" }),
    });
    expect(sig.status).toBe(200);

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.run_id).toBe(runId);
    expect(body.checkpoint).toMatchObject({
      node_id: "n_transform",
      pause_kind: "breakpoint",
      state: { flag: true },
    });
    expect(body.breakpoints.sort()).toEqual(["n_other", "n_transform"]);
  });


  it("bad checkpoint on resume fails dispatch; no cold-start job", async () => {
    const { runId } = await createPublishedRun();

    const pause = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "breakpoint_hit",
        node_id: "n_transform",
        payload: {
          checkpoint: {
            node_id: "n_transform",
            state: { flag: true },
            pause_kind: "breakpoint",
          },
        },
      }),
    });
    expect(pause.status).toBe(201);

    // Corrupt stored checkpoint, then queue for resume without going through
    // signalRun's parse (which would 400). Exercises pushJobToExecutor defense.
    const { db } = await import("../src/db/client");
    const { runs } = await import("../src/db/schema");
    const { pushJobToExecutor } = await import("../src/services/executor-client");
    await db
      .update(runs)
      .set({
        status: "queued",
        pauseReason: null,
        checkpointJson: { broken: true },
      })
      .where(eq(runs.id, runId));

    fetchMock.mockClear();
    await pushJobToExecutor(runId);

    expect(fetchMock).not.toHaveBeenCalled();

    const row = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage ?? "").toMatch(/invalid checkpoint on resume/i);

    const got = await app.request(`/runs/${runId}`, { headers: userHeaders });
    expect(got.status).toBe(200);
    const meta = await got.json();
    expect(meta.status).toBe("failed");
    expect(meta.errorMessage).toMatch(/invalid checkpoint on resume/i);
  });

  it("waiting_signal without checkpoint is rejected", async () => {
    const { runId } = await createPublishedRun();
    const bad = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "waiting_signal",
        node_id: "n_approve",
        payload: {},
      }),
    });
    expect(bad.status).toBe(400);
  });
});
