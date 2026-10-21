import { describe, it, expect, vi } from "vitest";
import type { FlowGraph } from "@awo/graph-schema";
import { createApiClient } from "./client";
import { saveThenPublish } from "./save-then-publish";

const graph: FlowGraph = {
  id: "g1",
  state_schema: { type: "object", properties: {} },
  nodes: [
    { id: "s", type: "Start", config: {}, ui: { x: 0, y: 0 } },
    {
      id: "branch_new",
      type: "Branch",
      config: { label: "unsaved" },
      ui: { x: 10, y: 20, variant: "decision" },
    },
  ],
  edges: [],
};

describe("saveThenPublish", () => {
  it("saves current graph then publishes; order is save → publish", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.endsWith("/draft") && method === "PUT") {
        const body = JSON.parse(String(init?.body));
        expect(body.graph.nodes).toHaveLength(2);
        expect(body.graph.nodes[1].id).toBe("branch_new");
        return new Response(
          JSON.stringify({
            versionId: "fv_draft",
            schemaHash: "b".repeat(64),
            version: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/publish") && method === "POST") {
        return new Response(
          JSON.stringify({
            versionId: "fv_pub",
            status: "published",
            version: 2,
            schemaHash: "b".repeat(64),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await saveThenPublish(client, "flow_1", graph);
    expect(result.saved.versionId).toBe("fv_draft");
    expect(result.published.versionId).toBe("fv_pub");
    expect(result.published.schemaHash).toBe(result.saved.schemaHash);
    expect(calls).toEqual([
      "PUT http://localhost:8787/flows/flow_1/draft",
      "POST http://localhost:8787/flows/flow_1/publish",
    ]);
  });

  it("does not publish when saveDraft fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/draft")) {
        return new Response(JSON.stringify({ error: "invalid graph" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`publish must not be called: ${init?.method} ${url}`);
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(saveThenPublish(client, "flow_1", graph)).rejects.toThrow(
      "invalid graph",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
