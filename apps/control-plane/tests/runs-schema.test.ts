import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

function isRollbackError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === "TransactionRollbackError" ||
    e.message === "Rollback" ||
    (typeof e.message === "string" && e.message.includes("Rollback"))
  );
}

describe("runs schema", () => {
  it("can insert a run and run_event then roll back", async () => {
    const { db } = await import("../src/db/client");
    const { runs, runEvents } = await import("../src/db/schema");

    try {
      await db.transaction(async (tx) => {
        await tx.insert(runs).values({
          id: "run_test_rollback",
          flowVersionId: "fv_does_not_need_fk",
          trigger: "test",
          status: "queued",
          inputJson: { question: "hi" },
          createdBy: "u_dev",
        });
        await tx.insert(runEvents).values({
          id: "re_test_rollback",
          runId: "run_test_rollback",
          seq: 1,
          nodeId: null,
          eventType: "run_started",
          payloadJson: {},
        });
        const rows = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, "run_test_rollback"));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("queued");
        const events = await tx
          .select()
          .from(runEvents)
          .where(eq(runEvents.runId, "run_test_rollback"));
        expect(events).toHaveLength(1);
        expect(events[0]?.seq).toBe(1);
        tx.rollback();
      });
    } catch (err: unknown) {
      if (!isRollbackError(err)) throw err;
    }

    const leftover = await db
      .select()
      .from(runs)
      .where(eq(runs.id, "run_test_rollback"));
    expect(leftover).toHaveLength(0);
  });

  it("runs table exposes checkpoint_json and pause_reason columns in schema export", async () => {
    const { runs } = await import("../src/db/schema");
    expect(runs.checkpointJson).toBeDefined();
    expect(runs.pauseReason).toBeDefined();
  });

  it("run_breakpoints and run_signals tables are defined", async () => {
    const { runBreakpoints, runSignals } = await import("../src/db/schema");
    expect(runBreakpoints.runId).toBeDefined();
    expect(runBreakpoints.nodeId).toBeDefined();
    expect(runBreakpoints.active).toBeDefined();
    expect(runSignals.kind).toBeDefined();
    expect(runSignals.payloadJson).toBeDefined();
    expect(runSignals.status).toBeDefined();
  });

  it("can insert paused run with checkpoint, breakpoint, and signal then roll back", async () => {
    const { db } = await import("../src/db/client");
    const { runs, runBreakpoints, runSignals } = await import("../src/db/schema");

    try {
      await db.transaction(async (tx) => {
        await tx.insert(runs).values({
          id: "run_m3_pause_rollback",
          flowVersionId: "fv_m3",
          trigger: "test",
          status: "paused",
          inputJson: {},
          checkpointJson: {
            node_id: "n_bp",
            state: { x: 1 },
            pause_kind: "breakpoint",
          },
          pauseReason: "breakpoint",
          createdBy: "u_dev",
        });
        await tx.insert(runBreakpoints).values({
          id: "rbp_m3_rollback",
          runId: "run_m3_pause_rollback",
          nodeId: "n_bp",
          active: 1,
        });
        await tx.insert(runSignals).values({
          id: "rsig_m3_rollback",
          runId: "run_m3_pause_rollback",
          kind: "resume",
          payloadJson: {},
          status: "pending",
        });
        const runRows = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, "run_m3_pause_rollback"));
        expect(runRows).toHaveLength(1);
        expect(runRows[0]?.pauseReason).toBe("breakpoint");
        expect(
          (runRows[0]?.checkpointJson as { node_id?: string } | null)?.node_id,
        ).toBe("n_bp");
        const bps = await tx
          .select()
          .from(runBreakpoints)
          .where(eq(runBreakpoints.runId, "run_m3_pause_rollback"));
        expect(bps).toHaveLength(1);
        expect(bps[0]?.active).toBe(1);
        const sigs = await tx
          .select()
          .from(runSignals)
          .where(eq(runSignals.runId, "run_m3_pause_rollback"));
        expect(sigs).toHaveLength(1);
        expect(sigs[0]?.kind).toBe("resume");
        tx.rollback();
      });
    } catch (err: unknown) {
      if (!isRollbackError(err)) throw err;
    }

    const leftover = await db
      .select()
      .from(runs)
      .where(eq(runs.id, "run_m3_pause_rollback"));
    expect(leftover).toHaveLength(0);
  });
});
