/**
 * M4: roles, assets, publish gate (+ draft test-run unlock with live executor).
 * Run via: `pnpm test:m4`
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for M4 integration (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

const TOKEN = process.env.EXECUTOR_TOKEN ?? "test-executor-token-m4";
process.env.EXECUTOR_TOKEN = TOKEN;

const jsonHeaders = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

const startEndGraph = {
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

const httpMissingUrlGraph = {
  id: "tmp",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "h", type: "HTTP", config: {}, ui: { x: 100, y: 0 } },
    { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
  ],
  edges: [
    {
      id: "e0",
      source: "s",
      sourceHandle: "out",
      target: "h",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e1",
      source: "h",
      sourceHandle: "out",
      target: "e",
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
  timeoutMs = 20_000,
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

/** Insert succeeded test run for draft version hash (fixture path). */
async function insertSucceededRunForHash(
  flowVersionId: string,
  createdBy = "u_dev",
): Promise<string> {
  const { db } = await import("../src/db/client");
  const { runs } = await import("../src/db/schema");
  const id = `run_m4fix_${crypto.randomUUID().replace(/-/g, "")}`;
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

describe("m4 integration", () => {
  let app: App;
  let cpServer: ReturnType<typeof serve> | null = null;
  let executorProc: ChildProcessWithoutNullStreams | null = null;
  let executorLog = "";
  let useLiveExecutor = false;

  beforeAll(async () => {
    vi.unstubAllGlobals();

    const mod = await import("../src/index");
    app = mod.app;

    // Prefer live executor (mirror test:m3). Fall back to fixture if spawn fails
    // or M4_GATE_FIXTURE=1 is set.
    if (process.env.M4_GATE_FIXTURE === "1") {
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

  it("builder node-defs hide Code; viewer cannot publish", async () => {
    const builderDefs = await app.request("/node-defs", {
      headers: jsonHeaders("u_builder"),
    });
    expect(builderDefs.status).toBe(200);
    const b = (await builderDefs.json()) as { typeKey: string }[];
    expect(b.some((x) => x.typeKey === "Code")).toBe(false);

    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: jsonHeaders("u_builder"),
      body: JSON.stringify({ name: `m4-viewer-pub-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    const saved = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers: jsonHeaders("u_builder"),
      body: JSON.stringify({ graph: startEndGraph }),
    });
    expect(saved.status).toBe(200);

    const pub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: jsonHeaders("u_viewer"),
    });
    expect(pub.status).toBe(403);
  });

  it("publish fails required_config then succeeds on bootstrap graph", async () => {
    const headers = jsonHeaders("u_builder");
    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `m4-cfg-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    const bad = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: httpMissingUrlGraph }),
    });
    expect(bad.status).toBe(200);

    const pubBad = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pubBad.status).toBe(400);
    const body = (await pubBad.json()) as {
      error: string;
      checks: { id: string; ok: boolean }[];
    };
    expect(body.error).toBe("publish_gate_failed");
    expect(body.checks.find((c) => c.id === "required_config")?.ok).toBe(false);

    const ok = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: startEndGraph }),
    });
    expect(ok.status).toBe(200);

    const pubOk = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pubOk.status).toBe(200);
  });

  it("after publish, changed draft blocked without matching test-run; developer draft run unlocks", async () => {
    const builder = jsonHeaders("u_builder");
    const dev = jsonHeaders("u_dev");

    const created = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers: builder,
      body: JSON.stringify({ name: `m4-unlock-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const { id: flowId } = (await created.json()) as { id: string };

    // 1) bootstrap publish Start→End
    const bootSave = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers: builder,
      body: JSON.stringify({ graph: startEndGraph }),
    });
    expect(bootSave.status).toBe(200);
    const bootPub = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: builder,
    });
    expect(bootPub.status).toBe(200);

    // 2) save draft with Transform change (new hash)
    const changedGraph = {
      ...startEndGraph,
      nodes: [
        { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
        {
          id: "t",
          type: "Transform",
          config: { assignments: { v: 1 } },
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

    const changed = await app.request(`/flows/${flowId}/draft`, {
      method: "PUT",
      headers: builder,
      body: JSON.stringify({ graph: changedGraph }),
    });
    expect(changed.status).toBe(200);
    const draftMeta = (await changed.json()) as {
      versionId: string;
      schemaHash: string;
    };

    // 3) publish as builder → 400 successful_test_run
    const blocked = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: builder,
    });
    expect(blocked.status).toBe(400);
    const blockedBody = (await blocked.json()) as {
      error: string;
      checks: { id: string; ok: boolean; message?: string }[];
    };
    expect(blockedBody.error).toBe("publish_gate_failed");
    expect(
      blockedBody.checks.find((c) => c.id === "successful_test_run")?.ok,
    ).toBe(false);

    // 4) draft test-run as u_dev (live executor) OR fixture
    if (useLiveExecutor) {
      const runRes = await app.request(`/flows/${flowId}/test-runs`, {
        method: "POST",
        headers: dev,
        body: JSON.stringify({ input: {}, graph_source: "draft" }),
      });
      expect(runRes.status).toBe(201);
      const run = (await runRes.json()) as { id: string };
      await waitForStatus(app, run.id, "succeeded", "u_dev", 25_000);
    } else {
      await insertSucceededRunForHash(draftMeta.versionId);
    }

    // 5) publish → 200
    const unlocked = await app.request(`/flows/${flowId}/publish`, {
      method: "POST",
      headers: builder,
    });
    expect(unlocked.status).toBe(200);
  });

  it("asset CRUD developer vs builder", async () => {
    const name = `m4_asset_${Date.now()}`;
    const asBuilder = await app.request("/assets/tools", {
      method: "POST",
      headers: jsonHeaders("u_builder"),
      body: JSON.stringify({ name, kind: "function", config: {} }),
    });
    expect(asBuilder.status).toBe(403);

    const asDev = await app.request("/assets/tools", {
      method: "POST",
      headers: jsonHeaders("u_dev"),
      body: JSON.stringify({
        name,
        kind: "function",
        config: {},
        allowed_roles: ["builder", "developer", "admin"],
      }),
    });
    expect(asDev.status).toBe(201);
    const tool = (await asDev.json()) as { id: string };

    const list = await app.request("/assets/tools", {
      headers: jsonHeaders("u_builder"),
    });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { name: string }[]).some((t) => t.name === name),
    ).toBe(true);

    const del = await app.request(`/assets/tools/${tool.id}`, {
      method: "DELETE",
      headers: jsonHeaders("u_dev"),
    });
    expect(del.status).toBe(204);
  });
});
