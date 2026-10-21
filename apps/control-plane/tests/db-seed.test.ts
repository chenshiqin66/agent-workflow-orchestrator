import { describe, it, expect } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

describe("seed", () => {
  it("has developer user and core node defs including Transform and Emit", async () => {
    const { db } = await import("../src/db/client");
    const { nodeDefs, users } = await import("../src/db/schema");
    const u = await db.query.users.findFirst({
      where: (t, { eq }) => eq(t.id, "u_dev"),
    });
    expect(u?.email).toBe("dev@example.com");
    const defs = await db.select().from(nodeDefs);
    const keys = defs.map((d) => d.typeKey).sort();
    expect(keys).toEqual([
      "Branch",
      "Breakpoint",
      "Emit",
      "End",
      "HTTP",
      "HumanApproval",
      "Input",
      "LLM",
      "Start",
      "Transform",
    ]);
    const transform = defs.find((d) => d.typeKey === "Transform");
    const emit = defs.find((d) => d.typeKey === "Emit");
    expect(transform?.category).toBe("data");
    expect(emit?.category).toBe("debug");
    expect((transform?.uiMeta as { shape?: string; color?: string })?.shape).toBe(
      "rounded",
    );
    expect((transform?.uiMeta as { color?: string })?.color).toBe("blue");
    expect((emit?.uiMeta as { shape?: string; color?: string })?.shape).toBe(
      "rounded",
    );
    expect((emit?.uiMeta as { color?: string })?.color).toBe("blue");
  });

  it("seed includes HumanApproval, Input, Breakpoint", async () => {
    const { db } = await import("../src/db/client");
    const { nodeDefs } = await import("../src/db/schema");
    const keys = await db.select({ typeKey: nodeDefs.typeKey }).from(nodeDefs);
    const set = new Set(keys.map((k) => k.typeKey));
    expect(set.has("HumanApproval")).toBe(true);
    expect(set.has("Input")).toBe(true);
    expect(set.has("Breakpoint")).toBe(true);

    const defs = await db.select().from(nodeDefs);
    const human = defs.find((d) => d.typeKey === "HumanApproval");
    const input = defs.find((d) => d.typeKey === "Input");
    const bp = defs.find((d) => d.typeKey === "Breakpoint");
    expect(human?.category).toBe("control");
    expect(input?.category).toBe("control");
    expect(bp?.category).toBe("debug");
    expect((human?.uiMeta as { color?: string })?.color).toBe("orange");
    expect((input?.uiMeta as { color?: string })?.color).toBe("teal");
    expect((bp?.uiMeta as { color?: string })?.color).toBe("red");
  });
});
