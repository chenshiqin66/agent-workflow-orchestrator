import { Hono } from "hono";
import { ZodError, z } from "zod";
import type { AuthVariables } from "../middleware/auth";
import {
  createKnowledgeBase,
  createModel,
  createTool,
  deleteKnowledgeBase,
  deleteModel,
  deleteTool,
  getKnowledgeBase,
  getModel,
  getTool,
  listKnowledgeBases,
  listModels,
  listTools,
  updateKnowledgeBase,
  updateModel,
  updateTool,
  type KnowledgeBaseRow,
  type ModelRow,
  type ToolRow,
} from "../services/asset-service";

const assetsRoutes = new Hono<{ Variables: AuthVariables }>();

const toolCreateSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  allowed_roles: z.array(z.string()).optional(),
});

const toolPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
    allowed_roles: z.array(z.string()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" });

const modelCreateSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const modelPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" });

const kbCreateSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const kbPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" });

function mapTool(row: ToolRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: row.configJson,
    allowed_roles: row.allowedRoles,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapModel(row: ModelRow) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    config: row.configJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapKb(row: KnowledgeBaseRow) {
  return {
    id: row.id,
    name: row.name,
    config: row.configJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function handleError(c: { json: (body: unknown, status: number) => Response }, e: unknown) {
  if (e instanceof ZodError) {
    return c.json({ error: "invalid body", details: e.flatten() }, 400);
  }
  const status = (e as { status?: number }).status ?? 500;
  return c.json({ error: (e as Error).message }, status as 400);
}

// —— tools ——
assetsRoutes.get("/assets/tools", async (c) => {
  const rows = await listTools(c.get("workspaceId"), c.get("role"));
  return c.json(rows.map(mapTool));
});

assetsRoutes.post("/assets/tools", async (c) => {
  try {
    const body = toolCreateSchema.parse(await c.req.json());
    const row = await createTool(c.get("workspaceId"), body, c.get("role"));
    return c.json(mapTool(row), 201);
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.get("/assets/tools/:id", async (c) => {
  try {
    const row = await getTool(c.get("workspaceId"), c.req.param("id"));
    return c.json(mapTool(row));
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.patch("/assets/tools/:id", async (c) => {
  try {
    const body = toolPatchSchema.parse(await c.req.json());
    const row = await updateTool(
      c.get("workspaceId"),
      c.req.param("id"),
      body,
      c.get("role"),
    );
    return c.json(mapTool(row));
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.delete("/assets/tools/:id", async (c) => {
  try {
    await deleteTool(c.get("workspaceId"), c.req.param("id"), c.get("role"));
    return c.body(null, 204);
  } catch (e) {
    return handleError(c, e);
  }
});

// —— models ——
assetsRoutes.get("/assets/models", async (c) => {
  const rows = await listModels(c.get("workspaceId"));
  return c.json(rows.map(mapModel));
});

assetsRoutes.post("/assets/models", async (c) => {
  try {
    const body = modelCreateSchema.parse(await c.req.json());
    const row = await createModel(c.get("workspaceId"), body, c.get("role"));
    return c.json(mapModel(row), 201);
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.get("/assets/models/:id", async (c) => {
  try {
    const row = await getModel(c.get("workspaceId"), c.req.param("id"));
    return c.json(mapModel(row));
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.patch("/assets/models/:id", async (c) => {
  try {
    const body = modelPatchSchema.parse(await c.req.json());
    const row = await updateModel(
      c.get("workspaceId"),
      c.req.param("id"),
      body,
      c.get("role"),
    );
    return c.json(mapModel(row));
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.delete("/assets/models/:id", async (c) => {
  try {
    await deleteModel(c.get("workspaceId"), c.req.param("id"), c.get("role"));
    return c.body(null, 204);
  } catch (e) {
    return handleError(c, e);
  }
});

// —— knowledge bases ——
assetsRoutes.get("/assets/knowledge-bases", async (c) => {
  const rows = await listKnowledgeBases(c.get("workspaceId"));
  return c.json(rows.map(mapKb));
});

assetsRoutes.post("/assets/knowledge-bases", async (c) => {
  try {
    const body = kbCreateSchema.parse(await c.req.json());
    const row = await createKnowledgeBase(
      c.get("workspaceId"),
      body,
      c.get("role"),
    );
    return c.json(mapKb(row), 201);
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.get("/assets/knowledge-bases/:id", async (c) => {
  try {
    const row = await getKnowledgeBase(c.get("workspaceId"), c.req.param("id"));
    return c.json(mapKb(row));
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.patch("/assets/knowledge-bases/:id", async (c) => {
  try {
    const body = kbPatchSchema.parse(await c.req.json());
    const row = await updateKnowledgeBase(
      c.get("workspaceId"),
      c.req.param("id"),
      body,
      c.get("role"),
    );
    return c.json(mapKb(row));
  } catch (e) {
    return handleError(c, e);
  }
});

assetsRoutes.delete("/assets/knowledge-bases/:id", async (c) => {
  try {
    await deleteKnowledgeBase(
      c.get("workspaceId"),
      c.req.param("id"),
      c.get("role"),
    );
    return c.body(null, 204);
  } catch (e) {
    return handleError(c, e);
  }
});

export { assetsRoutes };
