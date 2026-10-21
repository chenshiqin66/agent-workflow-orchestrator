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
});
