import { describe, it, expect, beforeAll } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

describe("roles node-defs filter", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  it("builder omits Code; developer includes Code", async () => {
    const builder = await app.request("/node-defs", {
      headers: { "X-User-Id": "u_builder" },
    });
    const developer = await app.request("/node-defs", {
      headers: { "X-User-Id": "u_dev" },
    });
    expect(builder.status).toBe(200);
    expect(developer.status).toBe(200);
    const b = (await builder.json()) as { typeKey: string }[];
    const d = (await developer.json()) as { typeKey: string }[];
    expect(b.some((x) => x.typeKey === "Code")).toBe(false);
    expect(d.some((x) => x.typeKey === "Code")).toBe(true);
  });

  it("builder omits Breakpoint; developer includes Breakpoint", async () => {
    const builder = await app.request("/node-defs", {
      headers: { "X-User-Id": "u_builder" },
    });
    const developer = await app.request("/node-defs", {
      headers: { "X-User-Id": "u_dev" },
    });
    const b = (await builder.json()) as { typeKey: string }[];
    const d = (await developer.json()) as { typeKey: string }[];
    expect(b.some((x) => x.typeKey === "Breakpoint")).toBe(false);
    expect(d.some((x) => x.typeKey === "Breakpoint")).toBe(true);
  });
});
