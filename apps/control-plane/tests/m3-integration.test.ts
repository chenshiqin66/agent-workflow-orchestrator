/**
 * M3: pause → patch/signal → resume (+ cancel) with live Python executor.
 *
 * Spawns control-plane + uvicorn on ephemeral ports (same pattern as M2).
 * Run via: `pnpm test:m3`
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for M3 integration (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

const TOKEN = process.env.EXECUTOR_TOKEN ?? "test-executor-token-m3";
process.env.EXECUTOR_TOKEN = TOKEN;

const userHeaders = {
  "X-User-Id": "u_dev",
  "Content-Type": "application/json",
};

/** Start → Breakpoint → Transform → Emit → End */
const breakpointGraph = {
  id: "fv_m3_breakpoint",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "n_start", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "n_bp", type: "Breakpoint", config: {}, ui: { x: 160, y: 0 } },
    {
      id: "n_transform",
      type: "Transform",
      config: { assignments: { label: "after-bp" } },
      ui: { x: 320, y: 0 },
    },
    {
      id: "n_emit",
      type: "Emit",
      config: { message: "resumed" },
      ui: { x: 480, y: 0 },
    },
    { id: "n_end", type: "End", config: {}, ui: { x: 640, y: 0 } },
  ],
  edges: [
    {
      id: "e1",
      source: "n_start",
      sourceHandle: "out",
      target: "n_bp",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e2",
      source: "n_bp",
      sourceHandle: "out",
      target: "n_transform",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e3",
      source: "n_transform",
      sourceHandle: "out",
      target: "n_emit",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e4",
      source: "n_emit",
      sourceHandle: "out",
      target: "n_end",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

/** Start → HumanApproval → (success|failure) Transform → End */
const approvalGraph = {
  id: "fv_m3_approval",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "n_start", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    {
      id: "n_approve",
      type: "HumanApproval",
      config: {},
      ui: { x: 160, y: 0 },
    },
    {
      id: "n_ok",
      type: "Transform",
      config: { assignments: { path: "approved" } },
      ui: { x: 320, y: -80 },
    },
    {
      id: "n_rej",
      type: "Transform",
      config: { assignments: { path: "rejected" } },
      ui: { x: 320, y: 80 },
    },
    { id: "n_end_ok", type: "End", config: {}, ui: { x: 480, y: -80 } },
    { id: "n_end_rej", type: "End", config: {}, ui: { x: 480, y: 80 } },
  ],
  edges: [
    {
      id: "e1",
      source: "n_start",
      sourceHandle: "out",
      target: "n_approve",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e2",
      source: "n_approve",
      sourceHandle: "success",
      target: "n_ok",
      targetHandle: "in",
      kind: "success",
      label: "approve",
    },
    {
      id: "e3",
      source: "n_approve",
      sourceHandle: "failure",
      target: "n_rej",
      targetHandle: "in",
      kind: "failure",
      label: "reject",
    },
    {
      id: "e4",
      source: "n_ok",
      sourceHandle: "out",
      target: "n_end_ok",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e5",
      source: "n_rej",
      sourceHandle: "out",
      target: "n_end_rej",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

/** Start → Input → Emit → End */
const inputGraph = {
  id: "fv_m3_input",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "n_start", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    {
      id: "n_input",
      type: "Input",
      config: {
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      ui: { x: 160, y: 0 },
    },
    {
      id: "n_emit",
      type: "Emit",
      config: { message: "got-input" },
      ui: { x: 320, y: 0 },
    },
    { id: "n_end", type: "End", config: {}, ui: { x: 480, y: 0 } },
  ],
  edges: [
    {
      id: "e1",
      source: "n_start",
      sourceHandle: "out",
      target: "n_input",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e2",
      source: "n_input",
      sourceHandle: "out",
      target: "n_emit",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e3",
      source: "n_emit",
      sourceHandle: "out",
      target: "n_end",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = addr;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

async function waitForUrl(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers: opts.headers });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}: ${String(lastErr)}`);
}

type App = { request: typeof import("../src/index").app.request };

type RunMeta = {
  id: string;
  status: string;
  pauseReason?: string | null;
  outputJson?: Record<string, unknown> | null;
  errorMessage?: string | null;
  checkpoint?: unknown;
};

async function waitForStatus(
  app: App,
  runId: string,
  want: string | string[],
  timeoutMs = 15_000,
): Promise<RunMeta> {
  const set = new Set(Array.isArray(want) ? want : [want]);
  const start = Date.now();
  let last: RunMeta | null = null;
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(`/runs/${runId}`, { headers: userHeaders });
    last = (await res.json()) as RunMeta;
    if (set.has(last.status)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `timeout waiting for ${[...set].join("|")}; last=${JSON.stringify(last)}`,
  );
}

async function publishFlow(
  app: App,
  name: string,
  graph: unknown,
): Promise<string> {
  const created = await app.request("/projects/p_demo/flows", {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name }),
  });
  expect(created.status).toBe(201);
  const { id: flowId } = (await created.json()) as { id: string };

  const saved = await app.request(`/flows/${flowId}/draft`, {
    method: "PUT",
    headers: userHeaders,
    body: JSON.stringify({ graph }),
  });
  expect(saved.status).toBe(200);

  const pub = await app.request(`/flows/${flowId}/publish`, {
    method: "POST",
    headers: userHeaders,
  });
  expect(pub.status).toBe(200);
  return flowId;
}

async function startTestRun(
  app: App,
  flowId: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const runRes = await app.request(`/flows/${flowId}/test-runs`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ input }),
  });
  expect(runRes.status).toBe(201);
  const run = (await runRes.json()) as { id: string };
  expect(run.id).toMatch(/^run_/);
  return run.id;
}

async function listEvents(app: App, runId: string) {
  const res = await app.request(`/runs/${runId}/events`, {
    headers: userHeaders,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    events: Array<{
      seq: number;
      eventType: string;
      nodeId: string | null;
      ts: string;
      payload: unknown;
    }>;
  };
  return body.events;
}

describe("M3 pause / signal / resume integration", () => {
  let app: App;
  let cpServer: ReturnType<typeof serve>;
  let executorProc: ChildProcessWithoutNullStreams | null = null;
  let executorLog = "";
  let cpPort = 0;
  let exPort = 0;

  beforeAll(async () => {
    vi.unstubAllGlobals();

    cpPort = await freePort();
    exPort = await freePort();
    process.env.CALLBACK_BASE_URL = `http://127.0.0.1:${cpPort}`;
    process.env.EXECUTOR_URL = `http://127.0.0.1:${exPort}`;
    process.env.EXECUTOR_TOKEN = TOKEN;

    const mod = await import("../src/index");
    app = mod.app;

    cpServer = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      try {
        const s = serve(
          { fetch: mod.app.fetch, port: cpPort, hostname: "127.0.0.1" },
          () => resolve(s),
        );
        s.on?.("error", reject);
      } catch (e) {
        reject(e);
      }
    });

    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const executorRoot = path.join(repoRoot, "apps/executor-py");
    const python = path.join(executorRoot, ".venv/bin/python");

    executorProc = spawn(
      python,
      [
        "-m",
        "uvicorn",
        "awo_executor.main:app",
        "--app-dir",
        "src",
        "--host",
        "127.0.0.1",
        "--port",
        String(exPort),
      ],
      {
        cwd: executorRoot,
        env: {
          ...process.env,
          EXECUTOR_TOKEN: TOKEN,
          PYTHONUNBUFFERED: "1",
        },
      },
    );
    executorProc.stdout.on("data", (b) => {
      executorLog += b.toString();
    });
    executorProc.stderr.on("data", (b) => {
      executorLog += b.toString();
    });
    executorProc.on("exit", (code) => {
      if (code && code !== 0) {
        executorLog += `\n[executor exited ${code}]\n`;
      }
    });

    try {
      await waitForUrl(`http://127.0.0.1:${cpPort}/health`);
      await waitForUrl(`http://127.0.0.1:${exPort}/health`);
    } catch (e) {
      throw new Error(
        `${String(e)}\n--- executor log ---\n${executorLog.slice(-4000)}`,
      );
    }
  }, 45_000);

  afterAll(async () => {
    if (executorProc && !executorProc.killed) {
      executorProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!executorProc.killed) executorProc.kill("SIGKILL");
    }
    await new Promise<void>((resolve) => {
      try {
        cpServer.close?.(() => resolve());
      } catch {
        resolve();
      }
      setTimeout(() => resolve(), 1000);
    });
  });

  it("Breakpoint node → patch state → resume → succeeded", async () => {
    const flowId = await publishFlow(
      app,
      `m3-bp-${Date.now()}`,
      breakpointGraph,
    );
    const runId = await startTestRun(app, flowId, { seed: 1 });

    const paused = await waitForStatus(app, runId, "paused");
    expect(paused.pauseReason).toBe("breakpoint");

    const putBp = await app.request(`/runs/${runId}/breakpoints`, {
      method: "PUT",
      headers: userHeaders,
      body: JSON.stringify({ node_ids: ["n_transform"] }),
    });
    expect(putBp.status).toBe(200);
    const bpBody = (await putBp.json()) as { node_ids: string[] };
    expect(bpBody.node_ids).toContain("n_transform");

    const getBp = await app.request(`/runs/${runId}/breakpoints`, {
      headers: userHeaders,
    });
    expect(getBp.status).toBe(200);
    expect(((await getBp.json()) as { node_ids: string[] }).node_ids).toEqual(
      bpBody.node_ids,
    );

    const patchRes = await app.request(`/runs/${runId}/state`, {
      method: "PATCH",
      headers: userHeaders,
      body: JSON.stringify({ patch: { debug: true } }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      status: string;
      checkpoint: { state: Record<string, unknown> };
    };
    expect(patched.status).toBe("paused");
    expect(patched.checkpoint.state).toMatchObject({ seed: 1, debug: true });

    const signalRes = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ kind: "resume" }),
    });
    expect(signalRes.status).toBe(200);

    // Dynamic BP on n_transform set while paused → second pause, then clear + resume
    const paused2 = await waitForStatus(app, runId, "paused", 20_000);
    expect(paused2.pauseReason).toBe("breakpoint");

    const clearBp = await app.request(`/runs/${runId}/breakpoints`, {
      method: "PUT",
      headers: userHeaders,
      body: JSON.stringify({ node_ids: [] }),
    });
    expect(clearBp.status).toBe(200);

    const resume2 = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ kind: "resume" }),
    });
    expect(resume2.status).toBe(200);

    const done = await waitForStatus(app, runId, ["succeeded", "failed"], 20_000);
    if (done.status !== "succeeded") {
      const ev = await listEvents(app, runId);
      throw new Error(
        `expected succeeded, got ${done.status}: ${done.errorMessage}\n` +
          `events=${JSON.stringify(ev)}\n` +
          `executorLog=${executorLog.slice(-3000)}`,
      );
    }
    expect(done.outputJson).toMatchObject({
      seed: 1,
      debug: true,
      label: "after-bp",
    });

    const events = await listEvents(app, runId);
    const types = events.map((e) => e.eventType);
    expect(types).toContain("breakpoint_hit");
    expect(types).toContain("state_patched");
    expect(types).toContain("signal_received");
    expect(types).toContain("emit");
  }, 60_000);

  it("HumanApproval approve → success path; reject → failure path", async () => {
    const flowId = await publishFlow(
      app,
      `m3-appr-${Date.now()}`,
      approvalGraph,
    );

    // Approve
    const runOk = await startTestRun(app, flowId, {});
    const pausedOk = await waitForStatus(app, runOk, "paused");
    expect(pausedOk.pauseReason).toBe("approval");

    const approve = await app.request(`/runs/${runOk}/signal`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ kind: "approve" }),
    });
    expect(approve.status).toBe(200);

    const doneOk = await waitForStatus(app, runOk, ["succeeded", "failed"], 20_000);
    expect(doneOk.status).toBe("succeeded");
    expect(doneOk.outputJson).toMatchObject({ path: "approved" });

    const evOk = await listEvents(app, runOk);
    expect(evOk.map((e) => e.eventType)).toContain("waiting_signal");
    expect(evOk.map((e) => e.eventType)).toContain("signal_received");

    // Reject (fresh run)
    const runRej = await startTestRun(app, flowId, {});
    const pausedRej = await waitForStatus(app, runRej, "paused");
    expect(pausedRej.pauseReason).toBe("approval");

    const reject = await app.request(`/runs/${runRej}/signal`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ kind: "reject" }),
    });
    expect(reject.status).toBe(200);

    const doneRej = await waitForStatus(
      app,
      runRej,
      ["succeeded", "failed"],
      20_000,
    );
    expect(doneRej.status).toBe("succeeded");
    expect(doneRej.outputJson).toMatchObject({ path: "rejected" });
  }, 60_000);

  it("Input signal merges values into state", async () => {
    const flowId = await publishFlow(
      app,
      `m3-input-${Date.now()}`,
      inputGraph,
    );
    const runId = await startTestRun(app, flowId, { prior: true });

    const paused = await waitForStatus(app, runId, "paused");
    expect(paused.pauseReason).toBe("input");

    const signal = await app.request(`/runs/${runId}/signal`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ kind: "input", payload: { name: "Ada" } }),
    });
    expect(signal.status).toBe(200);

    const done = await waitForStatus(app, runId, ["succeeded", "failed"], 20_000);
    if (done.status !== "succeeded") {
      throw new Error(
        `expected succeeded, got ${done.status}: ${done.errorMessage}\n` +
          `executorLog=${executorLog.slice(-2000)}`,
      );
    }
    expect(done.outputJson).toMatchObject({ prior: true, name: "Ada" });

    const events = await listEvents(app, runId);
    expect(events.map((e) => e.eventType)).toContain("waiting_signal");
    expect(events.map((e) => e.eventType)).toContain("signal_received");
    expect(events.map((e) => e.eventType)).toContain("emit");
  }, 40_000);

  it("cancel while paused → cancelled; no node_finished after cancel", async () => {
    const flowId = await publishFlow(
      app,
      `m3-cancel-${Date.now()}`,
      breakpointGraph,
    );
    const runId = await startTestRun(app, flowId, {});

    await waitForStatus(app, runId, "paused");

    const before = await listEvents(app, runId);
    const cancelAt = new Date().toISOString();

    const cancelRes = await app.request(`/runs/${runId}/cancel`, {
      method: "POST",
      headers: userHeaders,
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as { status: string };
    expect(cancelBody.status).toBe("cancelled");

    const meta = await waitForStatus(app, runId, "cancelled", 5_000);
    expect(meta.status).toBe("cancelled");

    // Give any late executor callbacks a moment, then assert
    await new Promise((r) => setTimeout(r, 500));
    const after = await listEvents(app, runId);
    const lateFinished = after.filter(
      (e) =>
        e.eventType === "node_finished" &&
        e.ts > cancelAt &&
        // only count finishes that weren't already present
        !before.some((b) => b.seq === e.seq),
    );
    expect(lateFinished).toEqual([]);
  }, 40_000);
});
