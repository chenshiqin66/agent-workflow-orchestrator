import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiClient } from "./client";
import type { FlowGraph } from "@awo/graph-schema";

const sampleGraph: FlowGraph = {
  id: "g1",
  state_schema: { type: "object", properties: {} },
  nodes: [{ id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } }],
  edges: [],
};

describe("api client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("saveDraft PUTs graph with X-User-Id and returns schemaHash", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:8787/flows/flow_1/draft");
      expect(init?.method).toBe("PUT");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-User-Id")).toBe("u_dev");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ graph: sampleGraph });
      return new Response(
        JSON.stringify({
          versionId: "fv_1",
          schemaHash: "a".repeat(64),
          version: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      userId: "u_dev",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.saveDraft("flow_1", sampleGraph);
    expect(result.versionId).toBe("fv_1");
    expect(result.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("createFlow POSTs name under project", async () => {
    let calledUrl = "";
    let calledMethod = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      calledUrl = String(input);
      calledMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ id: "flow_x", name: "Demo" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createApiClient({
      baseUrl: "http://api.test",
      fetchImpl,
    });

    const created = await client.createFlow("p_demo", "Demo");
    expect(created).toEqual({ id: "flow_x", name: "Demo" });
    expect(calledUrl).toBe("http://api.test/projects/p_demo/flows");
    expect(calledMethod).toBe("POST");
  });

  it("throws with server error message", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "flow not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = createApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getFlow("missing")).rejects.toThrow("flow not found");
  });

  it("publish throws with checks when gate fails", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: "publish_gate_failed",
          checks: [{ id: "required_config", ok: false, message: "missing url" }],
        }),
        { status: 400 },
      );
    const client = createApiClient({ fetchImpl, userId: "u_builder" });
    await expect(client.publish("flow_1")).rejects.toMatchObject({
      status: 400,
      body: { error: "publish_gate_failed" },
    });
  });

  it("listTools GETs /assets/tools", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/assets/tools");
      return new Response(JSON.stringify([{ id: "t1", name: "echo", kind: "function", config: {}, allowed_roles: [] }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userId: "u_dev",
    });
    const tools = await client.listTools();
    expect(tools[0]?.name).toBe("echo");
  });
});

  it("listTemplates GETs /templates", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/templates");
      return new Response(
        JSON.stringify([
          {
            id: "tpl1",
            name: "Demo",
            description: "",
            createdAt: "2026-10-22T00:00:00.000Z",
            sourceFlowVersionId: null,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = createApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userId: "u_viewer",
    });
    const list = await client.listTemplates();
    expect(list[0]?.name).toBe("Demo");
  });

  it("getFlowMetrics GETs /metrics/flows/:id", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/metrics/flows/flow_1");
      return new Response(
        JSON.stringify({
          flow_id: "flow_1",
          from: "2026-10-15T00:00:00.000Z",
          to: "2026-10-22T00:00:00.000Z",
          totals: {
            runs: 2,
            succeeded: 1,
            failed: 1,
            cancelled: 0,
            in_flight: 0,
            success_rate: 0.5,
            avg_latency_ms: 1000,
            sum_cost_tokens: 10,
            avg_cost_tokens: 5,
          },
          by_version: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = createApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userId: "u_viewer",
    });
    const m = await client.getFlowMetrics("flow_1");
    expect(m.totals.success_rate).toBe(0.5);
    expect(m.flow_id).toBe("flow_1");
  });
