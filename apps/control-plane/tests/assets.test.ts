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

  it("GET /assets/tools/:id enforces allowed_roles like list (404 when denied)", async () => {
    // Seed tool_demo_echo allows builder/developer/admin only — not viewer.
    const allowed = await app.request("/assets/tools/tool_demo_echo", {
      headers: { "X-User-Id": "u_builder" },
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      id: string;
      config: { secret_ref?: string };
    };
    expect(body.id).toBe("tool_demo_echo");
    expect(body.config?.secret_ref).toBe("env:DEMO_ECHO");

    const denied = await app.request("/assets/tools/tool_demo_echo", {
      headers: { "X-User-Id": "u_viewer" },
    });
    expect(denied.status).toBe(404);
    const err = (await denied.json()) as { error: string };
    expect(err.error).toMatch(/not found/i);

    // Viewer list must not include the restricted tool either.
    const list = await app.request("/assets/tools", {
      headers: { "X-User-Id": "u_viewer" },
    });
    expect(list.status).toBe(200);
    const tools = (await list.json()) as { id: string }[];
    expect(tools.some((t) => t.id === "tool_demo_echo")).toBe(false);
  });

  it("GET tool with empty allowed_roles is visible to any member", async () => {
    const name = `open_${Date.now()}`;
    const create = await app.request("/assets/tools", {
      method: "POST",
      headers: { "X-User-Id": "u_dev", "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        kind: "function",
        config: { note: "open" },
        allowed_roles: [],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const asViewer = await app.request(`/assets/tools/${created.id}`, {
      headers: { "X-User-Id": "u_viewer" },
    });
    expect(asViewer.status).toBe(200);
  });
});
