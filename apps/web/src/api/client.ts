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
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancel_requested";

export type PauseReason = "breakpoint" | "approval" | "input";

export type RunCheckpoint = {
  node_id: string;
  state: Record<string, unknown>;
  pause_kind: PauseReason;
  resume_edge_kind?: "success" | "failure" | "default";
  pending_input?: Record<string, unknown>;
};

export type SignalKind = "approve" | "reject" | "input" | "resume";

export type BreakpointsResult = {
  node_ids: string[];
};

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
  pauseReason?: PauseReason | string | null;
  checkpoint?: RunCheckpoint | null;
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

export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  sourceFlowVersionId: string | null;
};

export type MetricsTotals = {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  in_flight: number;
  success_rate: number;
  avg_latency_ms: number | null;
  sum_cost_tokens: number;
  avg_cost_tokens: number | null;
};

export type FlowMetrics = {
  flow_id: string;
  from: string;
  to: string;
  totals: MetricsTotals;
  by_version: Array<{
    flow_version_id: string;
    version: number;
    status: string;
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    success_rate: number;
    avg_latency_ms: number | null;
    sum_cost_tokens: number;
    avg_cost_tokens: number | null;
  }>;
};

export type WorkspaceMetrics = {
  from: string;
  to: string;
  flows: Array<{ flow_id: string; name: string; totals: MetricsTotals }>;
};


export type NodeDef = {
  id: string;
  typeKey: string;
  category: string;
  configSchema: unknown;
  uiMeta: unknown;
  minRole: string;
};

export type GateCheck = { id: string; ok: boolean; message?: string };

export type ApiErrorBody = {
  error?: string;
  checks?: GateCheck[];
  [key: string]: unknown;
};

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type Tool = {
  id: string;
  name: string;
  kind: string;
  config: unknown;
  allowed_roles: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type Model = {
  id: string;
  name: string;
  provider: string;
  config: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  config: unknown;
  createdAt?: string;
  updatedAt?: string;
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
      throw new ApiError(errMsg, res.status, body);
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
    createTestRun(
      flowId: string,
      input: unknown,
      opts?: { graphSource?: "draft" | "published" },
    ) {
      const body: Record<string, unknown> = { input };
      if (opts?.graphSource) body.graph_source = opts.graphSource;
      return request<CreateTestRunResult>(`/flows/${flowId}/test-runs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    createRun(
      flowId: string,
      input: unknown,
      opts?: { graphSource?: "draft" | "published" },
    ) {
      const body: Record<string, unknown> = { input };
      if (opts?.graphSource) body.graph_source = opts.graphSource;
      return request<CreateTestRunResult>(`/flows/${flowId}/test-runs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    listTools() {
      return request<Tool[]>(`/assets/tools`);
    },
    createTool(body: {
      name: string;
      kind: string;
      config?: Record<string, unknown>;
      allowed_roles?: string[];
    }) {
      return request<Tool>(`/assets/tools`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    deleteTool(id: string) {
      return request<void>(`/assets/tools/${id}`, { method: "DELETE" });
    },
    listModels() {
      return request<Model[]>(`/assets/models`);
    },
    createModel(body: {
      name: string;
      provider: string;
      config?: Record<string, unknown>;
    }) {
      return request<Model>(`/assets/models`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    deleteModel(id: string) {
      return request<void>(`/assets/models/${id}`, { method: "DELETE" });
    },
    listKnowledgeBases() {
      return request<KnowledgeBase[]>(`/assets/knowledge-bases`);
    },
    createKnowledgeBase(body: {
      name: string;
      config?: Record<string, unknown>;
    }) {
      return request<KnowledgeBase>(`/assets/knowledge-bases`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    deleteKnowledgeBase(id: string) {
      return request<void>(`/assets/knowledge-bases/${id}`, {
        method: "DELETE",
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
    signalRun(
      runId: string,
      body: { kind: SignalKind; payload?: unknown },
    ) {
      return request<RunDetail>(`/runs/${runId}/signal`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    patchRunState(
      runId: string,
      body: { state?: object; patch?: object },
    ) {
      return request<RunDetail>(`/runs/${runId}/state`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    getBreakpoints(runId: string) {
      return request<BreakpointsResult>(`/runs/${runId}/breakpoints`);
    },
    putBreakpoints(runId: string, nodeIds: string[]) {
      return request<BreakpointsResult>(`/runs/${runId}/breakpoints`, {
        method: "PUT",
        body: JSON.stringify({ node_ids: nodeIds }),
      });
    },
    listTemplates() {
      return request<TemplateSummary[]>(`/templates`);
    },
    createTemplate(body: {
      name: string;
      description?: string;
      flow_version_id: string;
    }) {
      return request<{ id: string; name: string }>(`/templates`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    cloneTemplate(
      id: string,
      body: { project_id: string; name: string },
    ) {
      return request<{ id: string; name: string }>(`/templates/${id}/clone`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    getFlowMetrics(
      flowId: string,
      q?: { from?: string; to?: string; trigger?: string },
    ) {
      const params = new URLSearchParams();
      if (q?.from) params.set("from", q.from);
      if (q?.to) params.set("to", q.to);
      if (q?.trigger) params.set("trigger", q.trigger);
      const qs = params.toString();
      return request<FlowMetrics>(
        `/metrics/flows/${flowId}${qs ? `?${qs}` : ""}`,
      );
    },
    getWorkspaceMetrics(q?: { from?: string; to?: string; trigger?: string }) {
      const params = new URLSearchParams();
      if (q?.from) params.set("from", q.from);
      if (q?.to) params.set("to", q.to);
      if (q?.trigger) params.set("trigger", q.trigger);
      const qs = params.toString();
      return request<WorkspaceMetrics>(
        `/metrics/workspace${qs ? `?${qs}` : ""}`,
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Default client bound to VITE_API_BASE / localhost:8787 */
export const api = createApiClient();
