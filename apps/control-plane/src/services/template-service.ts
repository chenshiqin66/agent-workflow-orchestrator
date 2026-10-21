import { and, eq } from "drizzle-orm";
import { hashGraph, type FlowGraph } from "@awo/graph-schema";
import { requireRole } from "../auth/roles";
import { db } from "../db/client";
import {
  flowTemplates,
  flowVersions,
  flows,
  projects,
} from "../db/schema";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function httpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  sourceFlowVersionId: string | null;
};

export async function listTemplates(
  workspaceId: string,
): Promise<TemplateSummary[]> {
  const rows = await db.query.flowTemplates.findMany({
    where: eq(flowTemplates.workspaceId, workspaceId),
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt,
    sourceFlowVersionId: r.sourceFlowVersionId,
  }));
}

export async function getTemplate(id: string, workspaceId: string) {
  const row = await db.query.flowTemplates.findFirst({
    where: and(
      eq(flowTemplates.id, id),
      eq(flowTemplates.workspaceId, workspaceId),
    ),
  });
  if (!row) throw httpError("template not found", 404);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    graph: row.graphJson,
    createdAt: row.createdAt,
    sourceFlowVersionId: row.sourceFlowVersionId,
    createdBy: row.createdBy,
  };
}

export async function createTemplateFromPublished(
  workspaceId: string,
  userId: string,
  role: string,
  body: { name: string; description?: string; flow_version_id: string },
) {
  requireRole(role, "developer");
  const ver = await db.query.flowVersions.findFirst({
    where: eq(flowVersions.id, body.flow_version_id),
  });
  if (!ver) throw httpError("flow version not found", 404);
  if (ver.status !== "published") {
    throw httpError("flow version must be published", 400);
  }
  const flow = await db.query.flows.findFirst({
    where: eq(flows.id, ver.flowId),
  });
  if (!flow) throw httpError("flow not found", 404);
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, flow.projectId),
      eq(projects.workspaceId, workspaceId),
    ),
  });
  if (!project) throw httpError("flow version not found", 404);

  const id = newId("tpl");
  await db.insert(flowTemplates).values({
    id,
    workspaceId,
    name: body.name,
    description: body.description ?? "",
    graphJson: ver.graphJson,
    sourceFlowVersionId: ver.id,
    createdBy: userId,
  });

  return {
    id,
    name: body.name,
    description: body.description ?? "",
    sourceFlowVersionId: ver.id,
  };
}

export async function deleteTemplate(
  id: string,
  workspaceId: string,
  role: string,
) {
  requireRole(role, "developer");
  const row = await db.query.flowTemplates.findFirst({
    where: and(
      eq(flowTemplates.id, id),
      eq(flowTemplates.workspaceId, workspaceId),
    ),
  });
  if (!row) throw httpError("template not found", 404);
  await db.delete(flowTemplates).where(eq(flowTemplates.id, id));
  return { ok: true };
}

export async function cloneTemplate(
  id: string,
  workspaceId: string,
  userId: string,
  role: string,
  body: { project_id: string; name: string },
): Promise<{ id: string; name: string }> {
  requireRole(role, "builder");
  const tpl = await db.query.flowTemplates.findFirst({
    where: and(
      eq(flowTemplates.id, id),
      eq(flowTemplates.workspaceId, workspaceId),
    ),
  });
  if (!tpl) throw httpError("template not found", 404);

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, body.project_id),
      eq(projects.workspaceId, workspaceId),
    ),
  });
  if (!project) throw httpError("project not found", 404);

  const flowId = newId("flow");
  const versionId = newId("fv");
  const src = tpl.graphJson as FlowGraph;
  const graph: FlowGraph = {
    ...src,
    id: versionId,
    nodes: Array.isArray(src.nodes) ? structuredClone(src.nodes) : [],
    edges: Array.isArray(src.edges) ? structuredClone(src.edges) : [],
    state_schema: src.state_schema ?? { type: "object", properties: {} },
  };
  const schemaHash = hashGraph(graph);

  await db.transaction(async (tx) => {
    await tx.insert(flows).values({
      id: flowId,
      projectId: body.project_id,
      name: body.name,
      latestDraftVersionId: versionId,
      publishedVersionId: null,
    });
    await tx.insert(flowVersions).values({
      id: versionId,
      flowId,
      version: 1,
      status: "draft",
      graphJson: graph,
      schemaHash,
      createdBy: userId,
    });
  });

  return { id: flowId, name: body.name };
}
