import { Hono } from "hono";
import { ZodError, z } from "zod";
import type { AuthVariables } from "../middleware/auth";
import {
  cloneTemplate,
  createTemplateFromPublished,
  deleteTemplate,
  getTemplate,
  listTemplates,
} from "../services/template-service";

const templatesRoutes = new Hono<{ Variables: AuthVariables }>();

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  flow_version_id: z.string().min(1),
});

const cloneSchema = z.object({
  project_id: z.string().min(1),
  name: z.string().min(1),
});

templatesRoutes.get("/templates", async (c) => {
  const rows = await listTemplates(c.get("workspaceId"));
  return c.json(rows);
});

templatesRoutes.get("/templates/:id", async (c) => {
  try {
    const row = await getTemplate(c.req.param("id"), c.get("workspaceId"));
    return c.json(row);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

templatesRoutes.post("/templates", async (c) => {
  try {
    const body = createSchema.parse(await c.req.json());
    const result = await createTemplateFromPublished(
      c.get("workspaceId"),
      c.get("userId"),
      c.get("role"),
      body,
    );
    return c.json(result, 201);
  } catch (e) {
    if (e instanceof ZodError) {
      return c.json({ error: "invalid body", details: e.flatten() }, 400);
    }
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

templatesRoutes.delete("/templates/:id", async (c) => {
  try {
    const result = await deleteTemplate(
      c.req.param("id"),
      c.get("workspaceId"),
      c.get("role"),
    );
    return c.json(result);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

templatesRoutes.post("/templates/:id/clone", async (c) => {
  try {
    const body = cloneSchema.parse(await c.req.json());
    const result = await cloneTemplate(
      c.req.param("id"),
      c.get("workspaceId"),
      c.get("userId"),
      c.get("role"),
      body,
    );
    return c.json(result, 201);
  } catch (e) {
    if (e instanceof ZodError) {
      return c.json({ error: "invalid body", details: e.flatten() }, 400);
    }
    const status = (e as { status?: number }).status ?? 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
});

export { templatesRoutes };
