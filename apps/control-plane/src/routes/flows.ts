import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth";
import { createFlow, getFlow, listNodeDefs } from "../services/flow-service";

const flowsRoutes = new Hono<{ Variables: AuthVariables }>();

flowsRoutes.post("/projects/:projectId/flows", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body?.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  try {
    const result = await createFlow(
      c.req.param("projectId"),
      body.name,
      c.get("userId"),
      c.get("workspaceId"),
      c.get("role"),
    );
    return c.json(result, 201);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

flowsRoutes.get("/flows/:flowId", async (c) => {
  try {
    const result = await getFlow(c.req.param("flowId"), c.get("workspaceId"));
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

flowsRoutes.get("/node-defs", async (c) => {
  const defs = await listNodeDefs(c.get("workspaceId"), c.get("role"));
  return c.json(
    defs.map((d) => ({
      id: d.id,
      typeKey: d.typeKey,
      category: d.category,
      configSchema: d.configSchema,
      uiMeta: d.uiMeta,
      minRole: d.minRole,
    })),
  );
});

export { flowsRoutes };
