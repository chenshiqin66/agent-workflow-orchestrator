import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { parseCallbackEvent, RunStatusSchema } from "@awo/run-protocol";
import { executorAuthMiddleware } from "../middleware/executor-auth";
import { db } from "../db/client";
import { runEvents, runs } from "../db/schema";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

const internalRunsRoutes = new Hono();

internalRunsRoutes.use("/internal/*", executorAuthMiddleware);

internalRunsRoutes.post("/internal/runs/:runId/events", async (c) => {
  const runId = c.req.param("runId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  let parsed;
  try {
    parsed = parseCallbackEvent(body);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "invalid event body" },
      400,
    );
  }

  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });
  if (!run) {
    return c.json({ error: "run not found" }, 404);
  }

  const inserted = await db.transaction(async (tx) => {
    const maxRow = await tx
      .select({ max: sql<number | null>`max(${runEvents.seq})` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    const nextSeq = (maxRow[0]?.max ?? 0) + 1;
    const id = newId("re");
    const ts = parsed.ts ? new Date(parsed.ts) : new Date();

    await tx.insert(runEvents).values({
      id,
      runId,
      seq: nextSeq,
      nodeId: parsed.node_id ?? null,
      eventType: parsed.event_type,
      payloadJson: parsed.payload,
      ts,
    });

    return {
      id,
      runId,
      seq: nextSeq,
      nodeId: parsed.node_id ?? null,
      eventType: parsed.event_type,
      payload: parsed.payload,
      ts: ts.toISOString(),
    };
  });

  return c.json(inserted, 201);
});

internalRunsRoutes.post("/internal/runs/:runId/status", async (c) => {
  const runId = c.req.param("runId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("status" in body)
  ) {
    return c.json({ error: "status is required" }, 400);
  }

  const statusResult = RunStatusSchema.safeParse(
    (body as { status: unknown }).status,
  );
  if (!statusResult.success) {
    return c.json({ error: "invalid status" }, 400);
  }
  const status = statusResult.data;

  const raw = body as {
    status: string;
    output?: unknown;
    error_message?: unknown;
  };

  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });
  if (!run) {
    return c.json({ error: "run not found" }, 404);
  }

  const now = new Date();
  const patch: {
    status: string;
    outputJson?: unknown;
    errorMessage?: string | null;
    startedAt?: Date;
    finishedAt?: Date;
  } = { status };

  if (status === "running" && !run.startedAt) {
    patch.startedAt = now;
  }
  if (TERMINAL.has(status)) {
    patch.finishedAt = now;
    if (!run.startedAt) {
      patch.startedAt = now;
    }
  }
  if (raw.output !== undefined) {
    patch.outputJson = raw.output;
  }
  if (typeof raw.error_message === "string") {
    patch.errorMessage = raw.error_message;
  } else if (raw.error_message === null) {
    patch.errorMessage = null;
  }

  await db.update(runs).set(patch).where(eq(runs.id, runId));

  return c.json({ id: runId, status });
});

export { internalRunsRoutes };
