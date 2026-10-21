import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth";
import {
  getFlowMetrics,
  getWorkspaceMetrics,
} from "../services/metrics-service";

const metricsRoutes = new Hono<{ Variables: AuthVariables }>();

function parseQuery(c: {
  req: { query: (k: string) => string | undefined };
}) {
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const trigger = c.req.query("trigger") ?? undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && Number.isNaN(from.getTime())) {
    return { error: "invalid from" as const };
  }
  if (to && Number.isNaN(to.getTime())) {
    return { error: "invalid to" as const };
  }
  return { from, to, trigger };
}

metricsRoutes.get("/metrics/flows/:flowId", async (c) => {
  const q = parseQuery(c);
  if ("error" in q && q.error) {
    return c.json({ error: q.error }, 400);
  }
  try {
    const result = await getFlowMetrics(
      c.req.param("flowId"),
      c.get("workspaceId"),
      { from: q.from, to: q.to, trigger: q.trigger },
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

metricsRoutes.get("/metrics/workspace", async (c) => {
  const q = parseQuery(c);
  if ("error" in q && q.error) {
    return c.json({ error: q.error }, 400);
  }
  try {
    const result = await getWorkspaceMetrics(c.get("workspaceId"), {
      from: q.from,
      to: q.to,
      trigger: q.trigger,
    });
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

export { metricsRoutes };
