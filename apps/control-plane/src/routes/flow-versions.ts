import { Hono } from "hono";
import { ZodError } from "zod";
import type { AuthVariables } from "../middleware/auth";
import { publishFlow, saveDraft } from "../services/flow-service";

const flowVersionRoutes = new Hono<{ Variables: AuthVariables }>();

flowVersionRoutes.put("/flows/:flowId/draft", async (c) => {
  const body = await c.req.json<{ graph?: unknown }>();
  if (body?.graph === undefined) {
    return c.json({ error: "graph is required" }, 400);
  }
  try {
    const result = await saveDraft(
      c.req.param("flowId"),
      body.graph,
      c.get("userId"),
      c.get("workspaceId"),
      c.get("role"),
    );
    return c.json(result);
  } catch (e) {
    if (e instanceof ZodError) {
      return c.json({ error: "invalid graph", details: e.flatten() }, 400);
    }
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

flowVersionRoutes.post("/flows/:flowId/publish", async (c) => {
  try {
    const result = await publishFlow(
      c.req.param("flowId"),
      c.get("userId"),
      c.get("workspaceId"),
      c.get("role"),
    );
    return c.json(result);
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    if (body) {
      return c.json(body, 400);
    }
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

export { flowVersionRoutes };
