import { describe, it, expect, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

process.env.EXECUTOR_TOKEN = process.env.EXECUTOR_TOKEN ?? "test-executor-token";
process.env.EXECUTOR_URL =
  process.env.EXECUTOR_URL ?? "http://127.0.0.1:8790";
process.env.CALLBACK_BASE_URL =
  process.env.CALLBACK_BASE_URL ?? "http://127.0.0.1:8787";

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 202 }),
      ),
    );
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

describe("M3 pause / signal / state / breakpoints", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 202 }),
      ),
    );
    const mod = await import("../src/index");
    app = mod.app;
  });

  const executorHeaders = {
    "X-Executor-Token": process.env.EXECUTOR_TOKEN!,
    "Content-Type": "application/json",
  };

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

  async function saveAndPublish(flowId: string): Promise<void> {
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
  }

  async function markRunning(runId: string): Promise<void> {
    const res = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({ status: "running" }),
    });
    expect(res.status).toBe(200);
  }

  async function createPausedBreakpointRun(): Promise<string> {
    const flowId = await createFlow(`m3-pause-${Date.now()}-${Math.random()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { flag: true } }),
    });
    expect(created.status).toBe(201);
    const { id: runId } = await created.json();
    await markRunning(runId as string);

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
    return runId as string;
  }

  async function createPausedApprovalRun(): Promise<string> {
    const flowId = await createFlow(`m3-appr-${Date.now()}-${Math.random()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    expect(created.status).toBe(201);
    const { id: runId } = await created.json();
    await markRunning(runId as string);

    const pause = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "waiting_signal",
        node_id: "n_approve",
        payload: {
          checkpoint: {
            node_id: "n_approve",
            state: { x: 1 },
            pause_kind: "approval",
          },
        },
      }),
    });
    expect(pause.status).toBe(201);
    return runId as string;
  }

  async function createPausedInputRun(): Promise<string> {
    const flowId = await createFlow(`m3-input-${Date.now()}-${Math.random()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    expect(created.status).toBe(201);
    const { id: runId } = await created.json();
    await markRunning(runId as string);

    const pause = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "waiting_signal",
        node_id: "n_input",
        payload: {
          checkpoint: {
            node_id: "n_input",
            state: { base: 1 },
            pause_kind: "input",
          },
        },
      }),
    });
    expect(pause.status).toBe(201);
    return runId as string;
  }

  it("pause event sets run to paused and stores checkpoint", async () => {
    const runId = await createPausedBreakpointRun();
    const run = await app.request(`/runs/${runId}`, { headers });
    expect(run.status).toBe(200);
    const body = await run.json();
    expect(body.status).toBe("paused");
    expect(body.pauseReason).toBe("breakpoint");
    expect(body.checkpoint.node_id).toBe("n_transform");
    expect(body.checkpoint.state).toEqual({ flag: true });
  });

  it("resume after breakpoint re-queues and dispatches", async () => {
    const runId = await createPausedBreakpointRun();
    const sig = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "resume" }),
    });
    expect(sig.status).toBe(200);
    const body = await sig.json();
    expect(["queued", "running"]).toContain(body.status);

    const got = await app.request(`/runs/${runId}`, { headers });
    const meta = await got.json();
    expect(["queued", "running"]).toContain(meta.status);

    const ev = await app.request(`/runs/${runId}/events?after_seq=0`, {
      headers,
    });
    const types = (await ev.json()).events.map(
      (e: { eventType: string }) => e.eventType,
    );
    expect(types).toContain("signal_received");
  });

  it("rejects approve when pause_reason is breakpoint", async () => {
    const runId = await createPausedBreakpointRun();
    const sig = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "approve" }),
    });
    expect(sig.status).toBe(400);
  });

  it("approve on approval pause sets resume_edge and re-dispatches", async () => {
    const runId = await createPausedApprovalRun();
    const sig = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "approve" }),
    });
    expect(sig.status).toBe(200);
    const got = await app.request(`/runs/${runId}`, { headers });
    const meta = await got.json();
    expect(["queued", "running"]).toContain(meta.status);
    expect(meta.checkpoint.resume_edge_kind).toBe("success");
  });

  it("PATCH state while paused emits state_patched", async () => {
    const runId = await createPausedBreakpointRun();
    const res = await app.request(`/runs/${runId}/state`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ patch: { debug: 1 } }),
    });
    expect(res.status).toBe(200);
    const patched = await res.json();
    expect(patched.checkpoint.state).toEqual({ flag: true, debug: 1 });
    expect(patched.status).toBe("paused");

    const ev = await app.request(`/runs/${runId}/events?after_seq=0`, {
      headers,
    });
    const types = (await ev.json()).events.map(
      (e: { eventType: string }) => e.eventType,
    );
    expect(types).toContain("state_patched");
  });

  it("cancel while paused → cancelled", async () => {
    const runId = await createPausedBreakpointRun();
    const res = await app.request(`/runs/${runId}/cancel`, {
      method: "POST",
      headers,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("cancelled");

    const got = await app.request(`/runs/${runId}`, { headers });
    const meta = await got.json();
    expect(meta.status).toBe("cancelled");
    expect(meta.finishedAt).toBeTruthy();
    expect(meta.pauseReason).toBeNull();
  });


  it("pause event after succeeded leaves status succeeded", async () => {
    const flowId = await createFlow(`m3-term-${Date.now()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    expect(created.status).toBe(201);
    const { id: runId } = await created.json();

    const done = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({ status: "succeeded", output: { ok: true } }),
    });
    expect(done.status).toBe(200);

    const late = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "breakpoint_hit",
        node_id: "n_late",
        payload: {
          checkpoint: {
            node_id: "n_late",
            state: {},
            pause_kind: "breakpoint",
          },
        },
      }),
    });
    expect(late.status).toBe(201);

    const got = await app.request(`/runs/${runId}`, { headers });
    const meta = await got.json();
    expect(meta.status).toBe("succeeded");
    expect(meta.finishedAt).toBeTruthy();
    expect(meta.pauseReason).toBeNull();

    // Status-channel pause also ignored
    const statusPause = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(statusPause.status).toBe(200);
    expect((await statusPause.json()).status).toBe("succeeded");

    const got2 = await app.request(`/runs/${runId}`, { headers });
    expect((await got2.json()).status).toBe("succeeded");
  });

  it("pause event while queued does not set paused", async () => {
    const flowId = await createFlow(`m3-queued-${Date.now()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    expect(created.status).toBe(201);
    const { id: runId } = await created.json();

    const pause = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "breakpoint_hit",
        node_id: "n_transform",
        payload: {
          checkpoint: {
            node_id: "n_transform",
            state: {},
            pause_kind: "breakpoint",
          },
        },
      }),
    });
    expect(pause.status).toBe(201);

    const got = await app.request(`/runs/${runId}`, { headers });
    const meta = await got.json();
    expect(meta.status).toBe("queued");
    expect(meta.pauseReason).toBeNull();
    expect(meta.checkpoint).toBeNull();
  });

  it("pause event while cancel_requested does not overwrite cancel", async () => {
    const flowId = await createFlow(`m3-cx-${Date.now()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    expect(created.status).toBe(201);
    const { id: runId } = await created.json();
    await markRunning(runId as string);

    const cancel = await app.request(`/runs/${runId}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).status).toBe("cancel_requested");

    const pause = await app.request(`/internal/runs/${runId}/events`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        event_type: "breakpoint_hit",
        node_id: "n_transform",
        payload: {
          checkpoint: {
            node_id: "n_transform",
            state: {},
            pause_kind: "breakpoint",
          },
        },
      }),
    });
    expect(pause.status).toBe(201);

    const got = await app.request(`/runs/${runId}`, { headers });
    expect((await got.json()).status).toBe("cancel_requested");

    const statusPause = await app.request(`/internal/runs/${runId}/status`, {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(statusPause.status).toBe(200);
    expect((await statusPause.json()).status).toBe("cancel_requested");
  });

  it("second resume after first fails; only one signal_received (CAS)", async () => {
    const runId = await createPausedBreakpointRun();
    const first = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "resume" }),
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "resume" }),
    });
    // Pre-check sees queued → 400; a true race would hit CAS → 409.
    expect([400, 409]).toContain(second.status);

    const ev = await app.request(`/runs/${runId}/events?after_seq=0`, {
      headers,
    });
    const signalCount = (await ev.json()).events.filter(
      (e: { eventType: string }) => e.eventType === "signal_received",
    ).length;
    expect(signalCount).toBe(1);
  });

  it("concurrent resume signals: only one succeeds", async () => {
    const runId = await createPausedBreakpointRun();
    const [a, b] = await Promise.all([
      app.request(`/runs/${runId}/signal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "resume" }),
      }),
      app.request(`/runs/${runId}/signal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "resume" }),
      }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const fail = [a, b].filter((r) => r.status === 400 || r.status === 409);
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);

    const ev = await app.request(`/runs/${runId}/events?after_seq=0`, {
      headers,
    });
    const signalCount = (await ev.json()).events.filter(
      (e: { eventType: string }) => e.eventType === "signal_received",
    ).length;
    expect(signalCount).toBe(1);
  });

  it("input signal rejects non-object payload with 400", async () => {
    const runId = await createPausedInputRun();
    for (const payload of [[], "x", 1, null]) {
      const sig = await app.request(`/runs/${runId}/signal`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "input", payload }),
      });
      expect(sig.status).toBe(400);
      const body = await sig.json();
      expect(body.error).toMatch(/JSON object payload/i);
    }
    // still paused after rejects
    const got = await app.request(`/runs/${runId}`, { headers });
    expect((await got.json()).status).toBe("paused");

    const ok = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "input", payload: { answer: 42 } }),
    });
    expect(ok.status).toBe(200);
    const meta = await (await app.request(`/runs/${runId}`, { headers })).json();
    expect(meta.checkpoint.state).toMatchObject({ base: 1, answer: 42 });
    expect(meta.checkpoint.pending_input).toEqual({ answer: 42 });
  });

  it("PUT/GET breakpoints upserts active set", async () => {
    const flowId = await createFlow(`m3-bp-${Date.now()}`);
    await saveAndPublish(flowId);
    const created = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });
    const { id: runId } = await created.json();

    const put = await app.request(`/runs/${runId}/breakpoints`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ node_ids: ["n_a", "n_b"] }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).node_ids.sort()).toEqual(["n_a", "n_b"]);

    const get1 = await app.request(`/runs/${runId}/breakpoints`, { headers });
    expect(get1.status).toBe(200);
    expect((await get1.json()).node_ids.sort()).toEqual(["n_a", "n_b"]);

    const put2 = await app.request(`/runs/${runId}/breakpoints`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ node_ids: ["n_b", "n_c"] }),
    });
    expect(put2.status).toBe(200);
    expect((await put2.json()).node_ids.sort()).toEqual(["n_b", "n_c"]);

    const get2 = await app.request(`/runs/${runId}/breakpoints`, { headers });
    expect((await get2.json()).node_ids.sort()).toEqual(["n_b", "n_c"]);
  });
});
