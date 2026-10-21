import { describe, it, expect, beforeAll } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo). Local-dev without DB: skip running this package's tests.",
  );
}

describe("assets API", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  it("developer can create and list a tool; builder cannot create", async () => {
    const createBuilder = await app.request("/assets/tools", {
      method: "POST",
      headers: { "X-User-Id": "u_builder", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t1", kind: "function", config: {} }),
    });
    expect(createBuilder.status).toBe(403);

    const uniqueName = `t1_${Date.now()}`;
    const createDev = await app.request("/assets/tools", {
      method: "POST",
      headers: { "X-User-Id": "u_dev", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: uniqueName,
        kind: "function",
        config: { secret_ref: "env:DEMO" },
        allowed_roles: ["builder", "developer", "admin"],
      }),
    });
    expect(createDev.status).toBe(201);
    const list = await app.request("/assets/tools", {
      headers: { "X-User-Id": "u_builder" },
    });
    expect(list.status).toBe(200);
    const tools = (await list.json()) as { name: string }[];
    expect(tools.some((t) => t.name === uniqueName)).toBe(true);
  });
});
