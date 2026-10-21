import type { JobPayload } from "@awo/run-protocol";
import { CheckpointSchema } from "@awo/run-protocol";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { flowVersions, runBreakpoints, runEvents, runs } from "../db/schema";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function executorUrl(): string {
  return (process.env.EXECUTOR_URL ?? "http://127.0.0.1:8790").replace(
    /\/$/,
    "",
  );
}

export function callbackBaseUrl(): string {
  return (process.env.CALLBACK_BASE_URL ?? "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
}

/**
 * Shared secret for control-plane ↔ executor (`X-Executor-Token`).
 * Must be set via env `EXECUTOR_TOKEN` — there is no default; unset fails dispatch.
 */
export function executorToken(): string {
  const t = process.env.EXECUTOR_TOKEN;
  if (!t) {
    throw new Error(
      "EXECUTOR_TOKEN is not set; refuse to dispatch without a shared secret",
    );
  }
  return t;
}

/**
 * Build JobPayload for a queued run and POST to the Python executor.
 * On missing EXECUTOR_TOKEN, network, or non-2xx: mark run `failed`, set
 * error_message, append a log event.
 */
export async function pushJobToExecutor(runId: string): Promise<void> {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });
  if (!run) {
    throw new Error(`run not found: ${runId}`);
  }

  const version = await db.query.flowVersions.findFirst({
    where: eq(flowVersions.id, run.flowVersionId),
  });
  if (!version) {
    throw new Error(`flow_version not found for run ${runId}`);
  }

  const bpRows = await db
    .select()
    .from(runBreakpoints)
    .where(
      and(eq(runBreakpoints.runId, runId), eq(runBreakpoints.active, 1)),
    );
  const breakpoints = bpRows.map((r) => r.nodeId);

  let checkpoint: JobPayload["checkpoint"] | undefined;
  // Resume path: queued run with a stored checkpoint (first create has null).
  // Never cold-start when a checkpoint was expected but is unparseable.
  if (run.status === "queued" && run.checkpointJson != null) {
    try {
      checkpoint = CheckpointSchema.parse(run.checkpointJson);
    } catch (err) {
      const message =
        err instanceof Error
          ? `invalid checkpoint on resume: ${err.message}`
          : "invalid checkpoint on resume";
      await markDispatchFailed(runId, message);
      return;
    }
  }

  try {
    const token = executorToken();
    const payload: JobPayload = {
      run_id: run.id,
      flow_version_id: version.id,
      graph: version.graphJson as JobPayload["graph"],
      input: (run.inputJson ?? {}) as Record<string, unknown>,
      callback_base_url: callbackBaseUrl(),
      token,
      ...(checkpoint ? { checkpoint } : {}),
      ...(breakpoints.length > 0 ? { breakpoints } : {}),
    };

    const url = `${executorUrl()}/v1/jobs`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Executor-Token": token,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `executor dispatch HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : `executor dispatch failed: ${String(err)}`;
    await markDispatchFailed(runId, message);
  }
}

async function markDispatchFailed(
  runId: string,
  errorMessage: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({
        status: "failed",
        errorMessage,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));

    const maxRow = await tx
      .select({ max: sql<number | null>`max(${runEvents.seq})` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    const nextSeq = (maxRow[0]?.max ?? 0) + 1;

    await tx.insert(runEvents).values({
      id: newId("re"),
      runId,
      seq: nextSeq,
      nodeId: null,
      eventType: "log",
      payloadJson: {
        level: "error",
        message: `executor dispatch failed: ${errorMessage}`,
      },
    });
  });
}
