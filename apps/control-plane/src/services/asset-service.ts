import { and, eq } from "drizzle-orm";
import { requireRole } from "../auth/roles";
import { db } from "../db/client";
import { knowledgeBases, models, tools } from "../db/schema";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function httpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "23505"
  );
}

export type ToolRow = typeof tools.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;

export type CreateToolInput = {
  name: string;
  kind: string;
  config?: Record<string, unknown>;
  allowed_roles?: string[];
};

export type UpdateToolInput = {
  name?: string;
  kind?: string;
  config?: Record<string, unknown>;
  allowed_roles?: string[];
};

export type CreateModelInput = {
  name: string;
  provider: string;
  config?: Record<string, unknown>;
};

export type UpdateModelInput = {
  name?: string;
  provider?: string;
  config?: Record<string, unknown>;
};

export type CreateKbInput = {
  name: string;
  config?: Record<string, unknown>;
};

export type UpdateKbInput = {
  name?: string;
  config?: Record<string, unknown>;
};

function toolVisibleToRole(allowedRoles: unknown, role: string): boolean {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return true;
  return allowedRoles.includes(role);
}

export async function createTool(
  workspaceId: string,
  input: CreateToolInput,
  role: string,
): Promise<ToolRow> {
  requireRole(role, "developer");
  const id = newId("tool");
  const now = new Date();
  try {
    const [row] = await db
      .insert(tools)
      .values({
        id,
        workspaceId,
        name: input.name,
        kind: input.kind,
        configJson: input.config ?? {},
        allowedRoles: input.allowed_roles ?? [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError("tool name already exists", 409);
    throw e;
  }
}

export async function listTools(
  workspaceId: string,
  role: string,
): Promise<ToolRow[]> {
  const rows = await db
    .select()
    .from(tools)
    .where(eq(tools.workspaceId, workspaceId));
  return rows.filter((t) => toolVisibleToRole(t.allowedRoles, role));
}

export async function getTool(
  workspaceId: string,
  id: string,
  role?: string,
): Promise<ToolRow> {
  const row = await db.query.tools.findFirst({
    where: and(eq(tools.id, id), eq(tools.workspaceId, workspaceId)),
  });
  if (!row) throw httpError("tool not found", 404);
  // Role-gated reads match listTools; omit role for developer writes (update).
  if (role !== undefined && !toolVisibleToRole(row.allowedRoles, role)) {
    throw httpError("tool not found", 404);
  }
  return row;
}

export async function updateTool(
  workspaceId: string,
  id: string,
  patch: UpdateToolInput,
  role: string,
): Promise<ToolRow> {
  requireRole(role, "developer");
  await getTool(workspaceId, id);
  const set: Partial<typeof tools.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.config !== undefined) set.configJson = patch.config;
  if (patch.allowed_roles !== undefined) set.allowedRoles = patch.allowed_roles;
  try {
    const [row] = await db
      .update(tools)
      .set(set)
      .where(and(eq(tools.id, id), eq(tools.workspaceId, workspaceId)))
      .returning();
    if (!row) throw httpError("tool not found", 404);
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError("tool name already exists", 409);
    throw e;
  }
}

export async function deleteTool(
  workspaceId: string,
  id: string,
  role: string,
): Promise<void> {
  requireRole(role, "developer");
  const deleted = await db
    .delete(tools)
    .where(and(eq(tools.id, id), eq(tools.workspaceId, workspaceId)))
    .returning({ id: tools.id });
  if (deleted.length === 0) throw httpError("tool not found", 404);
}

export async function createModel(
  workspaceId: string,
  input: CreateModelInput,
  role: string,
): Promise<ModelRow> {
  requireRole(role, "developer");
  const id = newId("model");
  const now = new Date();
  try {
    const [row] = await db
      .insert(models)
      .values({
        id,
        workspaceId,
        name: input.name,
        provider: input.provider,
        configJson: input.config ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError("model name already exists", 409);
    throw e;
  }
}

export async function listModels(workspaceId: string): Promise<ModelRow[]> {
  return db.select().from(models).where(eq(models.workspaceId, workspaceId));
}

export async function getModel(
  workspaceId: string,
  id: string,
): Promise<ModelRow> {
  const row = await db.query.models.findFirst({
    where: and(eq(models.id, id), eq(models.workspaceId, workspaceId)),
  });
  if (!row) throw httpError("model not found", 404);
  return row;
}

export async function updateModel(
  workspaceId: string,
  id: string,
  patch: UpdateModelInput,
  role: string,
): Promise<ModelRow> {
  requireRole(role, "developer");
  await getModel(workspaceId, id);
  const set: Partial<typeof models.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.config !== undefined) set.configJson = patch.config;
  try {
    const [row] = await db
      .update(models)
      .set(set)
      .where(and(eq(models.id, id), eq(models.workspaceId, workspaceId)))
      .returning();
    if (!row) throw httpError("model not found", 404);
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw httpError("model name already exists", 409);
    throw e;
  }
}

export async function deleteModel(
  workspaceId: string,
  id: string,
  role: string,
): Promise<void> {
  requireRole(role, "developer");
  const deleted = await db
    .delete(models)
    .where(and(eq(models.id, id), eq(models.workspaceId, workspaceId)))
    .returning({ id: models.id });
  if (deleted.length === 0) throw httpError("model not found", 404);
}

export async function createKnowledgeBase(
  workspaceId: string,
  input: CreateKbInput,
  role: string,
): Promise<KnowledgeBaseRow> {
  requireRole(role, "developer");
  const id = newId("kb");
  const now = new Date();
  try {
    const [row] = await db
      .insert(knowledgeBases)
      .values({
        id,
        workspaceId,
        name: input.name,
        configJson: input.config ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw httpError("knowledge base name already exists", 409);
    }
    throw e;
  }
}

export async function listKnowledgeBases(
  workspaceId: string,
): Promise<KnowledgeBaseRow[]> {
  return db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.workspaceId, workspaceId));
}

export async function getKnowledgeBase(
  workspaceId: string,
  id: string,
): Promise<KnowledgeBaseRow> {
  const row = await db.query.knowledgeBases.findFirst({
    where: and(
      eq(knowledgeBases.id, id),
      eq(knowledgeBases.workspaceId, workspaceId),
    ),
  });
  if (!row) throw httpError("knowledge base not found", 404);
  return row;
}

export async function updateKnowledgeBase(
  workspaceId: string,
  id: string,
  patch: UpdateKbInput,
  role: string,
): Promise<KnowledgeBaseRow> {
  requireRole(role, "developer");
  await getKnowledgeBase(workspaceId, id);
  const set: Partial<typeof knowledgeBases.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.config !== undefined) set.configJson = patch.config;
  try {
    const [row] = await db
      .update(knowledgeBases)
      .set(set)
      .where(
        and(
          eq(knowledgeBases.id, id),
          eq(knowledgeBases.workspaceId, workspaceId),
        ),
      )
      .returning();
    if (!row) throw httpError("knowledge base not found", 404);
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw httpError("knowledge base name already exists", 409);
    }
    throw e;
  }
}

export async function deleteKnowledgeBase(
  workspaceId: string,
  id: string,
  role: string,
): Promise<void> {
  requireRole(role, "developer");
  const deleted = await db
    .delete(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, id),
        eq(knowledgeBases.workspaceId, workspaceId),
      ),
    )
    .returning({ id: knowledgeBases.id });
  if (deleted.length === 0) throw httpError("knowledge base not found", 404);
}
