import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { requireRole } from "../auth/roles";
import type { Checkpoint, RunStatus, SignalKind } from "@awo/run-protocol";
import {
  CheckpointSchema,
  RunStatusSchema,
  SignalKindSchema,
} from "@awo/run-protocol";
import { db } from "../db/client";
import {
  auditLogs,
  flowVersions,
  flows,
  projects,
  runBreakpoints,
  runEvents,
  runSignals,
  runs,
} from "../db/schema";
import { pushJobToExecutor } from "./executor-client";

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
 * Push job to the Python executor after create.
 * Network failures are handled inside pushJobToExecutor (run → failed + log event).
 */
export async function dispatchJob(runId: string): Promise<void> {
  await pushJobToExecutor(runId);
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

async function appendEvent(
  tx: Tx,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
  nodeId: string | null = null,
) {
  const maxRow = await tx
    .select({ max: sql<number | null>`max(${runEvents.seq})` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  const nextSeq = (maxRow[0]?.max ?? 0) + 1;
  const id = newId("re");
  await tx.insert(runEvents).values({
    id,
    runId,
    seq: nextSeq,
    nodeId,
    eventType,
    payloadJson: payload,
  });
  return { id, seq: nextSeq };
}

function parseCheckpoint(raw: unknown): Checkpoint | null {
  if (raw == null) return null;
  const parsed = CheckpointSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function createTestRun(
  flowId: string,
  input: Record<string, unknown>,
  userId: string,
  workspaceId: string,
  role: string,
  graphSource: "published" | "draft" = "published",
): Promise<{ id: string; status: RunStatus; flowVersionId: string }> {
  requireRole(role, "builder");
  const flow = await getFlowOwned(flowId, workspaceId);

  const source = graphSource ?? "published";
  let versionId: string;

  if (source === "draft") {
    requireRole(role, "developer");
    if (!flow.latestDraftVersionId) {
      throw httpError("no draft version to test-run", 400);
    }
    const draft = await db.query.flowVersions.findFirst({
      where: eq(flowVersions.id, flow.latestDraftVersionId),
    });
    if (!draft || draft.status !== "draft") {
      throw httpError("draft version missing or not draft", 400);
    }
    versionId = draft.id;
  } else {
    if (!flow.publishedVersionId) {
      throw httpError("no published version to test-run", 400);
    }
    const published = await db.query.flowVersions.findFirst({
      where: eq(flowVersions.id, flow.publishedVersionId),
    });
    if (!published || published.status !== "published") {
      throw httpError("published version missing or not published", 400);
    }
    versionId = published.id;
  }

  const runId = newId("run");

  await db.transaction(async (tx: Tx) => {
    await tx.insert(runs).values({
      id: runId,
      flowVersionId: versionId,
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
        flowVersionId: versionId,
        trigger: "test",
        graphSource: source,
      },
    });
  });

  await dispatchJob(runId);

  // Re-read: push failure marks the run failed before we respond.
  const after = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });
  const status = RunStatusSchema.parse(after?.status ?? "queued");

  return {
    id: runId,
    status,
    flowVersionId: versionId,
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
    pauseReason: run.pauseReason ?? null,
    checkpoint: parseCheckpoint(run.checkpointJson),
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

export async function cancelRun(runId: string, workspaceId: string, role: string) {
  requireRole(role, "builder");
  const { run } = await assertRunInWorkspace(runId, workspaceId);
  const status = RunStatusSchema.parse(run.status);

  if (status === "paused") {
    await db
      .update(runs)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        pauseReason: null,
      })
      .where(eq(runs.id, runId));
    return { id: runId, status: "cancelled" as const };
  }

  if (status !== "queued" && status !== "running") {
    throw httpError(`cannot cancel run in status ${status}`, 400);
  }

  await db
    .update(runs)
    .set({ status: "cancel_requested" })
    .where(eq(runs.id, runId));

  return { id: runId, status: "cancel_requested" as const };
}

function mapSignalDbKind(kind: SignalKind): string {
  if (kind === "approve" || kind === "reject") return "approval";
  return kind;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export async function signalRun(
  runId: string,
  workspaceId: string,
  body: { kind?: unknown; payload?: unknown },
  role: string,
) {
  requireRole(role, "builder");
  const kindParsed = SignalKindSchema.safeParse(body.kind);
  if (!kindParsed.success) {
    throw httpError("invalid kind", 400);
  }
  const kind = kindParsed.data;

  // Input requires a plain JSON object; do not silently coerce [] / scalars to {}.
  if (kind === "input") {
    if (!isPlainObject(body.payload)) {
      throw httpError("input signal requires a JSON object payload", 400);
    }
  }

  const payload = isPlainObject(body.payload) ? body.payload : undefined;

  const { run } = await assertRunInWorkspace(runId, workspaceId);
  const status = RunStatusSchema.parse(run.status);
  if (status !== "paused") {
    throw httpError(`cannot signal run in status ${status}`, 400);
  }

  let cp: Checkpoint;
  try {
    cp = CheckpointSchema.parse(run.checkpointJson);
  } catch {
    throw httpError("paused run missing valid checkpoint", 400);
  }
  const reason = run.pauseReason;

  if (kind === "resume") {
    if (reason !== "breakpoint") {
      throw httpError("resume only valid for breakpoint pause", 400);
    }
  } else if (kind === "approve" || kind === "reject") {
    if (reason !== "approval") {
      throw httpError(`${kind} only valid for approval pause`, 400);
    }
    cp = {
      ...cp,
      resume_edge_kind: kind === "approve" ? "success" : "failure",
    };
  } else if (kind === "input") {
    if (reason !== "input") {
      throw httpError("input only valid for input pause", 400);
    }
    const values = payload!;
    cp = {
      ...cp,
      state: { ...cp.state, ...values },
      pending_input: values,
    };
  }

  await db.transaction(async (tx: Tx) => {
    // CAS: only one concurrent signal can leave paused → queued.
    const updated = await tx
      .update(runs)
      .set({
        checkpointJson: cp,
        status: "queued",
        pauseReason: null,
        finishedAt: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "paused")))
      .returning({ id: runs.id });

    if (updated.length === 0) {
      throw httpError("cannot signal run: no longer paused", 409);
    }

    await tx.insert(runSignals).values({
      id: newId("sig"),
      runId,
      kind: mapSignalDbKind(kind),
      payloadJson: {
        kind,
        ...(payload !== undefined ? { payload } : {}),
      },
      status: "consumed",
    });

    await appendEvent(tx, runId, "signal_received", {
      kind,
      ...(payload !== undefined ? { payload } : {}),
    }, cp.node_id);
  });

  await dispatchJob(runId);

  const after = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  return {
    id: runId,
    status: RunStatusSchema.parse(after?.status ?? "queued"),
    checkpoint: parseCheckpoint(after?.checkpointJson),
  };
}

export async function patchRunState(
  runId: string,
  workspaceId: string,
  body: { state?: unknown; patch?: unknown },
  role: string,
) {
  requireRole(role, "builder");
  const { run } = await assertRunInWorkspace(runId, workspaceId);
  const status = RunStatusSchema.parse(run.status);
  if (status !== "paused") {
    throw httpError(`cannot patch state in status ${status}`, 400);
  }

  let cp: Checkpoint;
  try {
    cp = CheckpointSchema.parse(run.checkpointJson);
  } catch {
    throw httpError("paused run missing valid checkpoint", 400);
  }

  let state: Record<string, unknown>;
  if (
    body.state !== undefined &&
    body.state !== null &&
    typeof body.state === "object" &&
    !Array.isArray(body.state)
  ) {
    state = body.state as Record<string, unknown>;
  } else if (
    body.patch !== undefined &&
    body.patch !== null &&
    typeof body.patch === "object" &&
    !Array.isArray(body.patch)
  ) {
    state = { ...cp.state, ...(body.patch as Record<string, unknown>) };
  } else {
    throw httpError("state or patch object is required", 400);
  }

  cp = { ...cp, state };

  await db.transaction(async (tx: Tx) => {
    await tx
      .update(runs)
      .set({ checkpointJson: cp })
      .where(eq(runs.id, runId));
    await appendEvent(tx, runId, "state_patched", { state }, cp.node_id);
  });

  return {
    id: runId,
    status: "paused" as const,
    pauseReason: run.pauseReason ?? null,
    checkpoint: cp,
  };
}

export async function putBreakpoints(
  runId: string,
  workspaceId: string,
  nodeIds: unknown,
  role: string,
) {
  requireRole(role, "builder");
  if (!Array.isArray(nodeIds) || !nodeIds.every((n) => typeof n === "string")) {
    throw httpError("node_ids must be an array of strings", 400);
  }
  const ids = [...new Set(nodeIds as string[])];
  await assertRunInWorkspace(runId, workspaceId);

  await db.transaction(async (tx: Tx) => {
    const existing = await tx
      .select()
      .from(runBreakpoints)
      .where(eq(runBreakpoints.runId, runId));
    const want = new Set(ids);

    for (const row of existing) {
      const active = want.has(row.nodeId) ? 1 : 0;
      if (row.active !== active) {
        await tx
          .update(runBreakpoints)
          .set({ active })
          .where(eq(runBreakpoints.id, row.id));
      }
      want.delete(row.nodeId);
    }

    for (const nodeId of want) {
      await tx.insert(runBreakpoints).values({
        id: newId("rbp"),
        runId,
        nodeId,
        active: 1,
      });
    }
  });

  return getBreakpoints(runId, workspaceId);
}

export async function getBreakpoints(runId: string, workspaceId: string) {
  await assertRunInWorkspace(runId, workspaceId);
  const rows = await db
    .select()
    .from(runBreakpoints)
    .where(
      and(eq(runBreakpoints.runId, runId), eq(runBreakpoints.active, 1)),
    );
  return { node_ids: rows.map((r) => r.nodeId).sort() };
}
