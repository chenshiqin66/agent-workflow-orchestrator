/**
 * M2 happy-path: control-plane + live Python executor (uvicorn) + Postgres.
 *
 * Spawns both HTTP servers on ephemeral ports; does NOT stub fetch.
 * Run via: `pnpm test:m2` (or vitest this file with DATABASE_URL set).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for M2 integration (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

const TOKEN = process.env.EXECUTOR_TOKEN ?? "test-executor-token-m2";
process.env.EXECUTOR_TOKEN = TOKEN;

const userHeaders = {
  "X-User-Id": "u_dev",
  "Content-Type": "application/json",
};

/** Start → Transform → Branch(flag) → Emit → End (+ failure End) */
const m2Graph = {
  id: "fv_m2_integration",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "n_start", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    {
      id: "n_transform",
      type: "Transform",
      config: { assignments: { label: "m2-ok", processed: true } },
      ui: { x: 160, y: 0 },
    },
    {
      id: "n_branch",
      type: "Branch",
      config: { expression: "state.flag == true" },
      ui: { x: 320, y: 0 },
    },
    {
      id: "n_emit",
      type: "Emit",
      config: { message: "flag was true" },
      ui: { x: 480, y: 0 },
    },
    { id: "n_end_ok", type: "End", config: {}, ui: { x: 640, y: 0 } },
    { id: "n_end_fail", type: "End", config: {}, ui: { x: 640, y: 120 } },
  ],
  edges: [
    {
      id: "e1",
      source: "n_start",
      sourceHandle: "out",
      target: "n_transform",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e2",
      source: "n_transform",
      sourceHandle: "out",
      target: "n_branch",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e3",
      source: "n_branch",
      sourceHandle: "success",
      target: "n_emit",
      targetHandle: "in",
      kind: "success",
      label: "yes",
    },
    {
      id: "e4",
      source: "n_branch",
      sourceHandle: "failure",
      target: "n_end_fail",
      targetHandle: "in",
      kind: "failure",
      label: "no",
    },
    {
      id: "e5",
      source: "n_emit",
      sourceHandle: "out",
      target: "n_end_ok",
      targetHandle: "in",
      kind: "success",
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

describe("M2 control-plane + executor happy path", () => {
  let app: { request: typeof import("../src/index").app.request };
  let cpServer: ReturnType<typeof serve>;
  let executorProc: ChildProcessWithoutNullStreams | null = null;
  let executorLog = "";
  let cpPort = 0;
  let exPort = 0;

  beforeAll(async () => {
    // Ensure unit-test fetch stubs from other files cannot win if pools share.
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

  it("publishes graph, test-runs, executor succeeds with timeline events", async () => {
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ name: `m2-integ-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    const saved = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers: userHeaders,
      body: JSON.stringify({ graph: m2Graph }),
    });
    expect(saved.status).toBe(200);

    const pub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: userHeaders,
    });
    expect(pub.status).toBe(200);

    const runRes = await app.request(`/flows/${flowId}/test-runs`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ input: { flag: true } }),
    });
    expect(runRes.status).toBe(201);
    const run = (await runRes.json()) as { id: string; status: string };
    expect(run.id).toMatch(/^run_/);
    // Dispatch accepted → still queued or already running (race with BG thread)
    expect(["queued", "running", "succeeded"]).toContain(run.status);
    expect(run.status).not.toBe("failed");

    const deadline = Date.now() + 25_000;
    let meta: {
      status: string;
      outputJson: Record<string, unknown> | null;
      errorMessage: string | null;
    } | null = null;
    while (Date.now() < deadline) {
      const got = await app.request(`/runs/${run.id}`, { headers: userHeaders });
      expect(got.status).toBe(200);
      meta = await got.json();
      if (
        meta &&
        (meta.status === "succeeded" ||
          meta.status === "failed" ||
          meta.status === "cancelled")
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!meta || meta.status !== "succeeded") {
      const ev = await app.request(`/runs/${run.id}/events`, {
        headers: userHeaders,
      });
      const body = await ev.json();
      throw new Error(
        `expected succeeded, got ${meta?.status}: ${meta?.errorMessage}\n` +
          `events=${JSON.stringify(body)}\n` +
          `executorLog=${executorLog.slice(-3000)}`,
      );
    }

    expect(meta.outputJson).toMatchObject({
      flag: true,
      label: "m2-ok",
      processed: true,
    });

    const eventsRes = await app.request(`/runs/${run.id}/events`, {
      headers: userHeaders,
    });
    expect(eventsRes.status).toBe(200);
    const { events } = (await eventsRes.json()) as {
      events: Array<{
        seq: number;
        eventType: string;
        nodeId: string | null;
      }>;
    };

    expect(events.length).toBeGreaterThan(0);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    const types = events.map((e) => e.eventType);
    expect(types).toContain("run_started");
    expect(types).toContain("emit");
    // engine posts terminal status, not a run_finished event

    const finishedNodeIds = events
      .filter((e) => e.eventType === "node_finished")
      .map((e) => e.nodeId);
    for (const id of [
      "n_start",
      "n_transform",
      "n_branch",
      "n_emit",
      "n_end_ok",
    ]) {
      expect(finishedNodeIds).toContain(id);
    }
    expect(finishedNodeIds).not.toContain("n_end_fail");

    const emitEv = events.find((e) => e.eventType === "emit");
    expect(emitEv?.nodeId).toBe("n_emit");
  }, 40_000);
});
