import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiClient } from "./client";

describe("api client — runs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createTestRun POSTs input under flow and returns id/status/flowVersionId", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://localhost:8787/flows/flow_1/test-runs",
      );
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-User-Id")).toBe("u_dev");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        input: { question: "demo", flag: true },
      });
      return new Response(
        JSON.stringify({
          id: "run_abc",
          status: "queued",
          flowVersionId: "fv_pub",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      userId: "u_dev",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.createTestRun("flow_1", {
      question: "demo",
      flag: true,
    });
    expect(result).toEqual({
      id: "run_abc",
      status: "queued",
      flowVersionId: "fv_pub",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("getRun GETs /runs/:id", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://localhost:8787/runs/run_abc");
      return new Response(
        JSON.stringify({
          id: "run_abc",
          flowVersionId: "fv_pub",
          trigger: "test",
          status: "running",
          inputJson: { flag: true },
          outputJson: null,
          errorMessage: null,
          startedAt: "2026-10-21T14:00:00.000Z",
          finishedAt: null,
          costTokens: 0,
          createdBy: "u_dev",
          createdAt: "2026-10-21T14:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const run = await client.getRun("run_abc");
    expect(run.id).toBe("run_abc");
    expect(run.status).toBe("running");
  });

  it("listRunEvents GETs events with optional after_seq", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "ev_1",
              runId: "run_abc",
              seq: 2,
              nodeId: "n_start",
              eventType: "node_started",
              payload: {},
              ts: "2026-10-21T14:00:01.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await client.listRunEvents("run_abc");
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.seq).toBe(2);

    await client.listRunEvents("run_abc", 2);
    expect(urls).toEqual([
      "http://localhost:8787/runs/run_abc/events",
      "http://localhost:8787/runs/run_abc/events?after_seq=2",
    ]);
  });

  it("cancelRun POSTs /runs/:id/cancel", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://localhost:8787/runs/run_abc/cancel",
      );
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({ id: "run_abc", status: "cancel_requested" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.cancelRun("run_abc");
    expect(result.status).toBe("cancel_requested");
  });
});
