import { describe, it, expect } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

describe("seed", () => {
  it("has developer user and core node defs", async () => {
    const { db } = await import("../src/db/client");
    const { nodeDefs, users } = await import("../src/db/schema");
    const u = await db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, "u_dev"),
    });
    expect(u?.email).toBe("dev@example.com");
    const defs = await db.select().from(nodeDefs);
    const keys = defs.map((d) => d.typeKey).sort();
    expect(keys).toEqual(["Branch", "End", "HTTP", "LLM", "Start"]);
  });
});
