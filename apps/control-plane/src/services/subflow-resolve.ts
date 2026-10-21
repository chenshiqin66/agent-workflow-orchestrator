import { and, eq } from "drizzle-orm";
import type { FlowGraph } from "@awo/graph-schema";
import { db } from "../db/client";
import { flowVersions, flows, projects } from "../db/schema";

export async function resolvePublishedForWorkspace(
  flowVersionId: string,
  workspaceId: string,
): Promise<{
  graph: FlowGraph;
  status: string;
  workspaceOk: boolean;
} | null> {
  const ver = await db.query.flowVersions.findFirst({
    where: eq(flowVersions.id, flowVersionId),
  });
  if (!ver) return null;
  const flow = await db.query.flows.findFirst({
    where: eq(flows.id, ver.flowId),
  });
  if (!flow) return null;
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, flow.projectId),
      eq(projects.workspaceId, workspaceId),
    ),
  });
  return {
    graph: ver.graphJson as FlowGraph,
    status: ver.status,
    workspaceOk: Boolean(project),
  };
}
