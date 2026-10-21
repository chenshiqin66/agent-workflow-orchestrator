import { describe, it, expect, beforeAll } from "vitest";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for @awo/control-plane tests (e.g. postgres://awo:awo@localhost:5432/awo).",
  );
}

const minimalGraph = {
  id: "tmp",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
  ],
  edges: [
    {
      id: "e0",
      source: "s",
      sourceHandle: "out",
      target: "e",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

const httpMissingUrlGraph = {
  id: "tmp",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    { id: "h", type: "HTTP", config: {}, ui: { x: 100, y: 0 } },
    { id: "e", type: "End", config: {}, ui: { x: 200, y: 0 } },
  ],
  edges: [
    {
      id: "e0",
      source: "s",
      sourceHandle: "out",
      target: "h",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
    {
      id: "e1",
      source: "h",
      sourceHandle: "out",
      target: "e",
      targetHandle: "in",
      kind: "default",
      label: "",
    },
  ],
};

describe("publish gate HTTP", () => {
  let app: { request: typeof import("../src/index").app.request };

  beforeAll(async () => {
    const mod = await import("../src/index");
    app = mod.app;
  });

  it("missing url → 400 with checks; bootstrap Start/End → 200", async () => {
    const headers = {
      "X-User-Id": "u_builder",
      "Content-Type": "application/json",
    };

    const badFlow = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `m4-gate-http-${Date.now()}` }),
    });
    expect(badFlow.status).toBe(201);
    const { id: badId } = await badFlow.json();

    const savedBad = await app.request(`/flows/${badId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: httpMissingUrlGraph }),
    });
    expect(savedBad.status).toBe(200);

    const pubBad = await app.request(`/flows/${badId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pubBad.status).toBe(400);
    const body = await pubBad.json();
    expect(body.error).toBe("publish_gate_failed");
    expect(body.checks.find((c: { id: string }) => c.id === "required_config")?.ok).toBe(
      false,
    );

    const okFlow = await app.request("/projects/p_demo/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `m4-gate-boot-${Date.now()}` }),
    });
    expect(okFlow.status).toBe(201);
    const { id: okId } = await okFlow.json();

    const savedOk = await app.request(`/flows/${okId}/draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ graph: minimalGraph }),
    });
    expect(savedOk.status).toBe(200);

    const pubOk = await app.request(`/flows/${okId}/publish`, {
      method: "POST",
      headers,
    });
    expect(pubOk.status).toBe(200);
    expect((await pubOk.json()).status).toBe("published");
  });
});
