import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { RunStatus } from "@awo/run-protocol";
import { RunStatusSchema } from "@awo/run-protocol";
import { db } from "../db/client";
import {
  auditLogs,
  flowVersions,
  flows,
  projects,
  runEvents,
  runs,
} from "../db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function httpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

/**
 * Hook for Task 4: push job to executor after create.
 * No-op in Task 3 so tests can create runs without a live executor.
 */
export async function dispatchJob(_runId: string): Promise<void> {
  // TODO(Task 4): call executor-client.dispatchJob
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

async function assertRunInWorkspace(runId: string, workspaceId: string) {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });
  if (!run) {
    throw httpError("run not found", 404);
  }
  const version = await db.query.flowVersions.findFirst({
    where: eq(flowVersions.id, run.flowVersionId),
  });
  if (!version) {
    throw httpError("run not found", 404);
  }
  await getFlowOwned(version.flowId, workspaceId);
  return { run, version };
}

export async function createTestRun(
  flowId: string,
  input: Record<string, unknown>,
  userId: string,
  workspaceId: string,
): Promise<{ id: string; status: RunStatus; flowVersionId: string }> {
  const flow = await getFlowOwned(flowId, workspaceId);

  if (!flow.publishedVersionId) {
    throw httpError("no published version to test-run", 400);
  }

  const published = await db.query.flowVersions.findFirst({
    where: eq(flowVersions.id, flow.publishedVersionId),
  });
  if (!published || published.status !== "published") {
    throw httpError("published version missing or not published", 400);
  }

  const runId = newId("run");

  await db.transaction(async (tx: Tx) => {
    await tx.insert(runs).values({
      id: runId,
      flowVersionId: published.id,
      trigger: "test",
      status: "queued",
      inputJson: input,
      createdBy: userId,
    });

    await tx.insert(auditLogs).values({
      id: newId("aud"),
      actor: userId,
      action: "run.test_create",
      resourceType: "run",
      resourceId: runId,
      diffJson: {
        flowId,
        flowVersionId: published.id,
        trigger: "test",
      },
    });
  });

  // Stub — Task 4 wires real executor push
  await dispatchJob(runId);

  return {
    id: runId,
    status: "queued",
    flowVersionId: published.id,
  };
}

export async function getRun(runId: string, workspaceId: string) {
  const { run } = await assertRunInWorkspace(runId, workspaceId);
  return {
    id: run.id,
    flowVersionId: run.flowVersionId,
    trigger: run.trigger,
    status: RunStatusSchema.parse(run.status),
    inputJson: run.inputJson,
    outputJson: run.outputJson,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    costTokens: run.costTokens,
    createdBy: run.createdBy,
    createdAt: run.createdAt.toISOString(),
  };
}

export async function listRunsForFlow(
  flowId: string,
  workspaceId: string,
  limit = 20,
) {
  await getFlowOwned(flowId, workspaceId);

  const versions = await db
    .select({ id: flowVersions.id })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId));
  const versionIds = versions.map((v) => v.id);
  if (versionIds.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(runs)
    .where(inArray(runs.flowVersionId, versionIds))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map((run) => ({
    id: run.id,
    flowVersionId: run.flowVersionId,
    trigger: run.trigger,
    status: RunStatusSchema.parse(run.status),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
}

export async function listRunEvents(
  runId: string,
  workspaceId: string,
  afterSeq = 0,
) {
  await assertRunInWorkspace(runId, workspaceId);

  const rows = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq));

  return {
    events: rows.map((e) => ({
      id: e.id,
      runId: e.runId,
      seq: e.seq,
      nodeId: e.nodeId,
      eventType: e.eventType,
      payload: e.payloadJson,
      ts: e.ts.toISOString(),
    })),
  };
}

export async function cancelRun(runId: string, workspaceId: string) {
  const { run } = await assertRunInWorkspace(runId, workspaceId);
  const status = RunStatusSchema.parse(run.status);

  if (status !== "queued" && status !== "running") {
    throw httpError(`cannot cancel run in status ${status}`, 400);
  }

  await db
    .update(runs)
    .set({ status: "cancel_requested" })
    .where(eq(runs.id, runId));

  return { id: runId, status: "cancel_requested" as const };
}
