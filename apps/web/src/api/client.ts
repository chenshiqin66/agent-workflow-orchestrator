import type { FlowGraph } from "@awo/graph-schema";

const DEFAULT_BASE = "http://localhost:8787";
const DEFAULT_USER = "u_dev";

export type ApiClientOptions = {
  baseUrl?: string;
  userId?: string;
  fetchImpl?: typeof fetch;
};

export type FlowSummary = {
  id: string;
  name: string;
};

export type FlowDetail = {
  id: string;
  projectId: string;
  name: string;
  latestDraftVersionId: string | null;
  publishedVersionId: string | null;
  draft: {
    id: string;
    version: number;
    schemaHash: string;
    status: string;
  } | null;
  graph: FlowGraph | null;
};

export type SaveDraftResult = {
  versionId: string;
  schemaHash: string;
  version: number;
};

export type PublishResult = {
  versionId: string;
  status: "published";
  version: number;
  schemaHash: string;
};

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancel_requested";

export type CreateTestRunResult = {
  id: string;
  status: RunStatus;
  flowVersionId: string;
};

export type RunDetail = {
  id: string;
  flowVersionId: string;
  trigger: string;
  status: RunStatus;
  inputJson: unknown;
  outputJson: unknown;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  costTokens: number | null;
  createdBy: string;
  createdAt: string;
};

export type RunEvent = {
  id: string;
  runId: string;
  seq: number;
  nodeId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  ts: string;
};

export type ListRunEventsResult = {
  events: RunEvent[];
};

export type CancelRunResult = {
  id: string;
  status: RunStatus;
};

export type NodeDef = {
  id: string;
  typeKey: string;
  category: string;
  configSchema: unknown;
  uiMeta: unknown;
  minRole: string;
};

function resolveBase(baseUrl?: string): string {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  const env =
    typeof import.meta !== "undefined"
      ? (import.meta as ImportMeta & { env?: { VITE_API_BASE?: string } }).env
          ?.VITE_API_BASE
      : undefined;
  return (env ?? DEFAULT_BASE).replace(/\/$/, "");
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = resolveBase(options.baseUrl);
  const userId = options.userId ?? DEFAULT_USER;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type") && init?.body) {
      headers.set("Content-Type", "application/json");
    }
    headers.set("X-User-Id", userId);

    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
    });

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const errMsg =
        body &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : `HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    return body as T;
  }

  return {
    baseUrl,
    userId,
    createFlow(projectId: string, name: string) {
      return request<FlowSummary>(`/projects/${projectId}/flows`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },
    getFlow(flowId: string) {
      return request<FlowDetail>(`/flows/${flowId}`);
    },
    saveDraft(flowId: string, graph: FlowGraph) {
      return request<SaveDraftResult>(`/flows/${flowId}/draft`, {
        method: "PUT",
        body: JSON.stringify({ graph }),
      });
    },
    publish(flowId: string) {
      return request<PublishResult>(`/flows/${flowId}/publish`, {
        method: "POST",
      });
    },
    listNodeDefs() {
      return request<NodeDef[]>(`/node-defs`);
    },
    createTestRun(flowId: string, input: unknown) {
      return request<CreateTestRunResult>(`/flows/${flowId}/test-runs`, {
        method: "POST",
        body: JSON.stringify({ input }),
      });
    },
    getRun(runId: string) {
      return request<RunDetail>(`/runs/${runId}`);
    },
    listRunEvents(runId: string, afterSeq?: number) {
      const q =
        afterSeq !== undefined && afterSeq > 0
          ? `?after_seq=${encodeURIComponent(String(afterSeq))}`
          : "";
      return request<ListRunEventsResult>(`/runs/${runId}/events${q}`);
    },
    cancelRun(runId: string) {
      return request<CancelRunResult>(`/runs/${runId}/cancel`, {
        method: "POST",
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Default client bound to VITE_API_BASE / localhost:8787 */
export const api = createApiClient();
