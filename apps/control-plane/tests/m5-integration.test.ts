/**
 * M5: subflow expand, templates, metrics (+ live executor for expand run).
 * Run via: `pnpm test:m5`
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for M5 integration (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

const TOKEN = process.env.EXECUTOR_TOKEN ?? "test-executor-token-m5";
process.env.EXECUTOR_TOKEN = TOKEN;

const jsonHeaders = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

const childGraph = {
  id: "tmp",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    {
      id: "t",
      type: "Transform",
      config: { set: { from_child: true } },
      ui: { x: 100, y: 0 },
    },
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

function parentWithSubflow(childVersionId: string) {
  return {
    id: "tmp",
    state_schema: { type: "object", properties: {} },
    nodes: [
      { id: "ps", type: "Start", config: {}, ui: { x: 0, y: 0 } },
      {
        id: "sf",
        type: "Subflow",
        config: { flow_version_id: childVersionId },
        ui: { x: 100, y: 0 },
      },
      { id: "pe", type: "End", config: {}, ui: { x: 200, y: 0 } },
    ],
    edges: [
      {
        id: "p0",
        source: "ps",
        sourceHandle: "out",
        target: "sf",
        targetHandle: "in",
        kind: "default",
        label: "",
      },
      {
        id: "p1",
        source: "sf",
        sourceHandle: "out",
        target: "pe",
        targetHandle: "in",
        kind: "default",
        label: "",
      },
    ],
  };
}

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

async function waitForUrl(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
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

async function waitForStatus(
  app: App,
  runId: string,
  want: string,
  userId = "u_dev",
  timeoutMs = 25_000,
) {
  const start = Date.now();
  let last: { status: string } | null = null;
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(`/runs/${runId}`, {
      headers: jsonHeaders(userId),
    });
    last = (await res.json()) as { status: string };
    if (last.status === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${want}; last=${JSON.stringify(last)}`);
}

describe("m5 integration", () => {
  let app: App;
  let cpServer: ReturnType<typeof serve> | null = null;
  let executorProc: ChildProcessWithoutNullStreams | null = null;
  let executorLog = "";
  let useLiveExecutor = false;

  beforeAll(async () => {
    vi.unstubAllGlobals();
    const mod = await import("../src/index");
    app = mod.app;

    if (process.env.M5_FIXTURE === "1") {
      useLiveExecutor = false;
      return;
    }

    try {
      const cpPort = await freePort();
      const exPort = await freePort();
      process.env.CALLBACK_BASE_URL = `http://127.0.0.1:${cpPort}`;
      process.env.EXECUTOR_URL = `http://127.0.0.1:${exPort}`;
      process.env.EXECUTOR_TOKEN = TOKEN;

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

      await waitForUrl(`http://127.0.0.1:${cpPort}/health`);
      await waitForUrl(`http://127.0.0.1:${exPort}/health`);
      useLiveExecutor = true;
    } catch (e) {
      executorLog += `\n[spawn failed: ${String(e)}]\n`;
      useLiveExecutor = false;
      if (executorProc && !executorProc.killed) {
        executorProc.kill("SIGKILL");
        executorProc = null;
      }
      if (cpServer) {
        try {
          cpServer.close?.();
        } catch {
          /* ignore */
        }
        cpServer = null;
      }
    }
  }, 45_000);

  afterAll(async () => {
    if (executorProc && !executorProc.killed) {
      executorProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (!executorProc.killed) executorProc.kill("SIGKILL");
    }
    if (cpServer) {
      await new Promise<void>((resolve) => {
        try {
          cpServer!.close?.(() => resolve());
        } catch {
          resolve();
        }
        setTimeout(() => resolve(), 1000);
      });
    }
  });

  it("publish child, parent Subflow expands and test-run succeeds", async () => {
    if (!useLiveExecutor) {
      console.warn("skipping live subflow run; executor unavailable", executorLog.slice(-500));
      return;
    }
    const dev = jsonHeaders("u_dev");

    const childCreate = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: dev,
      body: JSON.stringify({ name: `m5-child-${Date.now()}` }),
    });
    expect(childCreate.status).toBe(201);
    const { id: childFlowId } = (await childCreate.json()) as { id: string };

    const childSave = await app.request(`/flows/${childFlowId}/draft`, {
      method: "PUT",
      headers: dev,
      body: JSON.stringify({ graph: childGraph }),
    });
    expect(childSave.status).toBe(200);

    const childPub = await app.request(`/flows/${childFlowId}/publish`, {
      method: "POST",
      headers: dev,
    });
    expect(childPub.status).toBe(200);
    const { versionId: childVersionId } = (await childPub.json()) as {
      versionId: string;
    };

    const parentCreate = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: dev,
      body: JSON.stringify({ name: `m5-parent-${Date.now()}` }),
    });
    expect(parentCreate.status).toBe(201);
    const { id: parentFlowId } = (await parentCreate.json()) as { id: string };

    const parentSave = await app.request(`/flows/${parentFlowId}/draft`, {
      method: "PUT",
      headers: dev,
      body: JSON.stringify({ graph: parentWithSubflow(childVersionId) }),
    });
    expect(parentSave.status).toBe(200);

    const runRes = await app.request(`/flows/${parentFlowId}/test-runs`, {
      method: "POST",
      headers: dev,
      body: JSON.stringify({ input: {}, graph_source: "draft" }),
    });
    expect(runRes.status).toBe(201);
    const { id: runId } = (await runRes.json()) as { id: string };

    await waitForStatus(app, runId, "succeeded");

    const ev = await app.request(`/runs/${runId}/events`, {
      headers: dev,
    });
    expect(ev.status).toBe(200);
    const events = (await ev.json()) as {
      events?: { nodeId?: string | null; node_id?: string | null }[];
    } & { nodeId?: string | null }[];
    const list = Array.isArray(events)
      ? events
      : ((events as { events: { nodeId?: string | null }[] }).events ?? []);
    const ids = list
      .map((e) => e.nodeId ?? (e as { node_id?: string }).node_id)
      .filter(Boolean) as string[];
    expect(ids.some((id) => id.includes("sf__"))).toBe(true);
  }, 60_000);

  it("publish gate rejects bad subflow ref", async () => {
    const headers = jsonHeaders("u_dev");
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `m5-bad-sf-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    const save = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        graph: parentWithSubflow("fv_missing_definitely"),
      }),
    });
    expect(save.status).toBe(200);

    const pub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pub.status).toBe(400);
    const body = (await pub.json()) as {
      error: string;
      checks: { id: string; ok: boolean }[];
    };
    expect(body.error).toBe("publish_gate_failed");
    expect(body.checks.find((c) => c.id === "subflow_refs")?.ok).toBe(false);
  });

  it("template create + clone yields editable draft", async () => {
    const headers = jsonHeaders("u_dev");
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `m5-tpl-src-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    const save = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: childGraph }),
    });
    expect(save.status).toBe(200);

    const pub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pub.status).toBe(200);
    const { versionId } = (await pub.json()) as { versionId: string };

    const tplName = `m5_tpl_${Date.now()}`;
    const tpl = await app.request("/templates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: tplName,
        flow_version_id: versionId,
      }),
    });
    expect(tpl.status).toBe(201);
    const { id: tplId } = (await tpl.json()) as { id: string };

    const clone = await app.request(`/templates/${tplId}/clone`, {
      method: "POST",
      headers: jsonHeaders("u_builder"),
      body: JSON.stringify({
        project_id: "p_demo",
        name: `cloned_${Date.now()}`,
      }),
    });
    expect(clone.status).toBe(201);
    const { id: newFlowId } = (await clone.json()) as { id: string };

    const got = await app.request(`/flows/${newFlowId}`, {
      headers: jsonHeaders("u_builder"),
    });
    expect(got.status).toBe(200);
    const detail = (await got.json()) as { graph: { nodes: unknown[] } };
    expect(detail.graph.nodes.length).toBeGreaterThan(0);
  });

  it("metrics totals move after succeeded run", async () => {
    const headers = jsonHeaders("u_dev");
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `m5-metrics-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    const got = await app.request(`/flows/${flowId}`, { headers });
    const detail = (await got.json()) as { latestDraftVersionId: string };

    const { db } = await import("../src/db/client");
    const { runs } = await import("../src/db/schema");
    await db.insert(runs).values({
      id: `run_m5met_${crypto.randomUUID().replace(/-/g, "")}`,
      flowVersionId: detail.latestDraftVersionId,
      trigger: "test",
      status: "succeeded",
      inputJson: {},
      outputJson: {},
      costTokens: 7,
      startedAt: new Date("2026-10-22T01:00:00Z"),
      finishedAt: new Date("2026-10-22T01:00:01Z"),
      createdBy: "u_dev",
      createdAt: new Date(),
    });

    const res = await app.request(`/metrics/flows/${flowId}`, {
      headers: jsonHeaders("u_viewer"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { runs: number; success_rate: number; sum_cost_tokens: number };
    };
    expect(body.totals.runs).toBeGreaterThanOrEqual(1);
    expect(body.totals.success_rate).toBeDefined();
    expect(body.totals.sum_cost_tokens).toBeGreaterThanOrEqual(7);
  });
});
