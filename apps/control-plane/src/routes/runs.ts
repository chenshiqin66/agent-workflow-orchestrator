import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth";
import {
  cancelRun,
  createTestRun,
  getBreakpoints,
  getRun,
  listRunEvents,
  listRunsForFlow,
  patchRunState,
  putBreakpoints,
  signalRun,
} from "../services/run-service";

const runsRoutes = new Hono<{ Variables: AuthVariables }>();

runsRoutes.post("/flows/:flowId/test-runs", async (c) => {
  let body: { input?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (
    body?.input === undefined ||
    body.input === null ||
    typeof body.input !== "object" ||
    Array.isArray(body.input)
  ) {
    return c.json({ error: "input object is required" }, 400);
  }
  try {
    const result = await createTestRun(
      c.req.param("flowId"),
      body.input as Record<string, unknown>,
      c.get("userId"),
      c.get("workspaceId"),
    );
    return c.json(result, 201);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.get("/flows/:flowId/runs", async (c) => {
  try {
    const result = await listRunsForFlow(
      c.req.param("flowId"),
      c.get("workspaceId"),
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.get("/runs/:runId", async (c) => {
  try {
    const result = await getRun(c.req.param("runId"), c.get("workspaceId"));
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.get("/runs/:runId/events", async (c) => {
  const afterRaw = c.req.query("after_seq");
  const afterSeq =
    afterRaw === undefined || afterRaw === ""
      ? 0
      : Number.parseInt(afterRaw, 10);
  if (!Number.isFinite(afterSeq) || afterSeq < 0) {
    return c.json({ error: "after_seq must be a non-negative integer" }, 400);
  }
  try {
    const result = await listRunEvents(
      c.req.param("runId"),
      c.get("workspaceId"),
      afterSeq,
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.post("/runs/:runId/cancel", async (c) => {
  try {
    const result = await cancelRun(
      c.req.param("runId"),
      c.get("workspaceId"),
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.post("/runs/:runId/signal", async (c) => {
  let body: { kind?: unknown; payload?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const result = await signalRun(
      c.req.param("runId"),
      c.get("workspaceId"),
      body,
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.patch("/runs/:runId/state", async (c) => {
  let body: { state?: unknown; patch?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const result = await patchRunState(
      c.req.param("runId"),
      c.get("workspaceId"),
      body,
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.put("/runs/:runId/breakpoints", async (c) => {
  let body: { node_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const result = await putBreakpoints(
      c.req.param("runId"),
      c.get("workspaceId"),
      body.node_ids,
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

runsRoutes.get("/runs/:runId/breakpoints", async (c) => {
  try {
    const result = await getBreakpoints(
      c.req.param("runId"),
      c.get("workspaceId"),
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

export { runsRoutes };
