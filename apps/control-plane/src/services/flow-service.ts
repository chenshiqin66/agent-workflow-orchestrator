import { and, eq, max } from "drizzle-orm";
import { parseFlowGraph, hashGraph, type FlowGraph } from "@awo/graph-schema";
import { db } from "../db/client";
import {
  auditLogs,
  flowVersions,
  flows,
  nodeDefs,
  projects,
} from "../db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function httpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

export async function createFlow(
  projectId: string,
  name: string,
  userId: string,
  workspaceId: string,
): Promise<{ id: string; name: string }> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)),
  });
  if (!project) {
    throw httpError("project not found", 404);
  }

  const flowId = newId("flow");
  const versionId = newId("fv");
  const emptyGraph: FlowGraph = {
    id: versionId,
    state_schema: { type: "object", properties: {} },
    nodes: [],
    edges: [],
  };
  const schemaHash = hashGraph(emptyGraph);

  await db.transaction(async (tx) => {
    await tx.insert(flows).values({
      id: flowId,
      projectId,
      name,
      latestDraftVersionId: versionId,
      publishedVersionId: null,
    });

    await tx.insert(flowVersions).values({
      id: versionId,
      flowId,
      version: 1,
      status: "draft",
      graphJson: emptyGraph,
      schemaHash,
      createdBy: userId,
    });
  });

  return { id: flowId, name };
}

export async function getFlow(flowId: string, workspaceId: string) {
  const flow = await db.query.flows.findFirst({
    where: eq(flows.id, flowId),
  });
  if (!flow) {
    throw httpError("flow not found", 404);
  }

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, flow.projectId),
      eq(projects.workspaceId, workspaceId),
    ),
  });
  if (!project) {
    throw httpError("flow not found", 404);
  }

  let draftGraph: unknown = null;
  let draftVersion: {
    id: string;
    version: number;
    schemaHash: string;
    status: string;
  } | null = null;

  if (flow.latestDraftVersionId) {
    const ver = await db.query.flowVersions.findFirst({
      where: eq(flowVersions.id, flow.latestDraftVersionId),
    });
    if (ver) {
      draftGraph = ver.graphJson;
      draftVersion = {
        id: ver.id,
        version: ver.version,
        schemaHash: ver.schemaHash,
        status: ver.status,
      };
    }
  }

  return {
    id: flow.id,
    projectId: flow.projectId,
    name: flow.name,
    latestDraftVersionId: flow.latestDraftVersionId,
    publishedVersionId: flow.publishedVersionId,
    draft: draftVersion,
    graph: draftGraph,
  };
}

export async function saveDraft(
  flowId: string,
  graphInput: unknown,
  userId: string,
  workspaceId: string,
): Promise<{ versionId: string; schemaHash: string; version: number }> {
  const flow = await getFlowOwned(flowId, workspaceId);

  let draftRow =
    flow.latestDraftVersionId != null
      ? await db.query.flowVersions.findFirst({
          where: and(
            eq(flowVersions.id, flow.latestDraftVersionId),
            eq(flowVersions.status, "draft"),
          ),
        })
      : undefined;

  // If latest draft pointer is missing or points at a non-draft (e.g. published), create a new draft
  if (!draftRow) {
    const versionId = newId("fv");
    const parsed = parseFlowGraph({
      ...(graphInput as object),
      id: versionId,
    });
    const schemaHash = hashGraph(parsed);

    return db.transaction(async (tx) => {
      const nextVersion = await nextVersionNumber(flowId, tx);
      await tx.insert(flowVersions).values({
        id: versionId,
        flowId,
        version: nextVersion,
        status: "draft",
        graphJson: parsed,
        schemaHash,
        createdBy: userId,
      });
      await tx
        .update(flows)
        .set({ latestDraftVersionId: versionId })
        .where(eq(flows.id, flowId));
      return { versionId, schemaHash, version: nextVersion };
    });
  }

  const parsed = parseFlowGraph({
    ...(graphInput as object),
    id: draftRow.id,
  });
  const schemaHash = hashGraph(parsed);

  await db
    .update(flowVersions)
    .set({
      graphJson: parsed,
      schemaHash,
    })
    .where(eq(flowVersions.id, draftRow.id));

  return {
    versionId: draftRow.id,
    schemaHash,
    version: draftRow.version,
  };
}

export async function publishFlow(
  flowId: string,
  userId: string,
  workspaceId: string,
): Promise<{
  versionId: string;
  status: "published";
  version: number;
  schemaHash: string;
}> {
  const flow = await getFlowOwned(flowId, workspaceId);

  if (!flow.latestDraftVersionId) {
    throw httpError("no draft to publish", 400);
  }

  const draft = await db.query.flowVersions.findFirst({
    where: and(
      eq(flowVersions.id, flow.latestDraftVersionId),
      eq(flowVersions.status, "draft"),
    ),
  });
  if (!draft) {
    throw httpError("no draft to publish", 400);
  }

  const publishedId = newId("fv");
  const graph = draft.graphJson as FlowGraph;
  const graphWithId: FlowGraph = { ...graph, id: publishedId };
  const schemaHash = hashGraph(graphWithId);

  return db.transaction(async (tx) => {
    const versionNum = await nextVersionNumber(flowId, tx);

    await tx.insert(flowVersions).values({
      id: publishedId,
      flowId,
      version: versionNum,
      status: "published",
      graphJson: graphWithId,
      schemaHash,
      createdBy: userId,
    });

    await tx
      .update(flows)
      .set({ publishedVersionId: publishedId })
      .where(eq(flows.id, flowId));

    await tx.insert(auditLogs).values({
      id: newId("aud"),
      actor: userId,
      action: "flow.publish",
      resourceType: "flow",
      resourceId: flowId,
      diffJson: {
        publishedVersionId: publishedId,
        fromDraftVersionId: draft.id,
        version: versionNum,
        schemaHash,
      },
    });

    return {
      versionId: publishedId,
      status: "published" as const,
      version: versionNum,
      schemaHash,
    };
  });
}

export async function listNodeDefs(workspaceId: string) {
  return db
    .select()
    .from(nodeDefs)
    .where(eq(nodeDefs.workspaceId, workspaceId));
}

async function getFlowOwned(flowId: string, workspaceId: string) {
  const flow = await db.query.flows.findFirst({
    where: eq(flows.id, flowId),
  });
  if (!flow) {
    throw httpError("flow not found", 404);
  }
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, flow.projectId),
      eq(projects.workspaceId, workspaceId),
    ),
  });
  if (!project) {
    throw httpError("flow not found", 404);
  }
  return flow;
}

async function nextVersionNumber(flowId: string, client: DbOrTx = db): Promise<number> {
  const rows = await client
    .select({ v: max(flowVersions.version) })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId));
  const current = rows[0]?.v ?? 0;
  return current + 1;
}
