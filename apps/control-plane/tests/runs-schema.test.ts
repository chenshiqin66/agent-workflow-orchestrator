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
});
