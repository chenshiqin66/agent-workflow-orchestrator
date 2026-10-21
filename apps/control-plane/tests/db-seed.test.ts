import { describe, it, expect } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("seed", () => {
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
