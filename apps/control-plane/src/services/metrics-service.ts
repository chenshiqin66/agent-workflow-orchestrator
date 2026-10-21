import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client";
import { flowVersions, flows, projects, runs } from "../db/schema";

const IN_FLIGHT = new Set([
  "queued",
  "running",
  "paused",
  "cancel_requested",
]);

export type RunMetricRow = {
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  costTokens: number | null;
  flowVersionId: string;
  version: number;
  versionStatus: string;
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

export type VersionMetrics = {
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
};

function latencyMs(row: RunMetricRow): number | null {
  if (!row.startedAt || !row.finishedAt) return null;
  return row.finishedAt.getTime() - row.startedAt.getTime();
}

function summarize(rows: RunMetricRow[]): MetricsTotals {
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let in_flight = 0;
  let sumCost = 0;
  let costCount = 0;
  const latencies: number[] = [];

  for (const r of rows) {
    if (r.status === "succeeded") succeeded++;
    else if (r.status === "failed") failed++;
    else if (r.status === "cancelled") cancelled++;
    if (IN_FLIGHT.has(r.status)) in_flight++;
    if (r.costTokens != null) {
      sumCost += r.costTokens;
      costCount++;
    }
    const lat = latencyMs(r);
    if (lat != null) latencies.push(lat);
  }

  const completed = succeeded + failed + cancelled;
  const success_rate = completed === 0 ? 0 : succeeded / completed;
  const avg_latency_ms =
    latencies.length === 0
      ? null
      : latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const avg_cost_tokens = costCount === 0 ? null : sumCost / costCount;

  return {
    runs: rows.length,
    succeeded,
    failed,
    cancelled,
    in_flight,
    success_rate,
    avg_latency_ms,
    sum_cost_tokens: sumCost,
    avg_cost_tokens,
  };
}

export function aggregateRunRows(rows: RunMetricRow[]): {
  totals: MetricsTotals;
  by_version: VersionMetrics[];
} {
  const totals = summarize(rows);
  const byId = new Map<string, RunMetricRow[]>();
  for (const r of rows) {
    const list = byId.get(r.flowVersionId) ?? [];
    list.push(r);
    byId.set(r.flowVersionId, list);
  }
  const by_version: VersionMetrics[] = [];
  for (const [flowVersionId, group] of byId) {
    const s = summarize(group);
    const sample = group[0]!;
    by_version.push({
      flow_version_id: flowVersionId,
      version: sample.version,
      status: sample.versionStatus,
      runs: s.runs,
      succeeded: s.succeeded,
      failed: s.failed,
      cancelled: s.cancelled,
      success_rate: s.success_rate,
      avg_latency_ms: s.avg_latency_ms,
      sum_cost_tokens: s.sum_cost_tokens,
      avg_cost_tokens: s.avg_cost_tokens,
    });
  }
  by_version.sort((a, b) => a.version - b.version);
  return { totals, by_version };
}

function defaultRange(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

function httpError(message: string, status: number): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

async function assertFlowInWorkspace(flowId: string, workspaceId: string) {
  const flow = await db.query.flows.findFirst({ where: eq(flows.id, flowId) });
  if (!flow) throw httpError("flow not found", 404);
  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, flow.projectId),
      eq(projects.workspaceId, workspaceId),
    ),
  });
  if (!project) throw httpError("flow not found", 404);
  return flow;
}

export async function getFlowMetrics(
  flowId: string,
  workspaceId: string,
  opts: { from?: Date; to?: Date; trigger?: string } = {},
) {
  await assertFlowInWorkspace(flowId, workspaceId);
  const { from, to } = {
    from: opts.from ?? defaultRange().from,
    to: opts.to ?? defaultRange().to,
  };

  const conditions = [
    eq(flows.id, flowId),
    eq(projects.workspaceId, workspaceId),
    gte(runs.createdAt, from),
    lte(runs.createdAt, to),
  ];
  if (opts.trigger) {
    conditions.push(eq(runs.trigger, opts.trigger));
  }

  const rows = await db
    .select({
      status: runs.status,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      costTokens: runs.costTokens,
      flowVersionId: runs.flowVersionId,
      version: flowVersions.version,
      versionStatus: flowVersions.status,
    })
    .from(runs)
    .innerJoin(flowVersions, eq(runs.flowVersionId, flowVersions.id))
    .innerJoin(flows, eq(flowVersions.flowId, flows.id))
    .innerJoin(projects, eq(flows.projectId, projects.id))
    .where(and(...conditions));

  const agg = aggregateRunRows(rows);
  return {
    flow_id: flowId,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: agg.totals,
    by_version: agg.by_version,
  };
}

export async function getWorkspaceMetrics(
  workspaceId: string,
  opts: { from?: Date; to?: Date; trigger?: string } = {},
) {
  const { from, to } = {
    from: opts.from ?? defaultRange().from,
    to: opts.to ?? defaultRange().to,
  };

  const flowRows = await db
    .select({ id: flows.id, name: flows.name })
    .from(flows)
    .innerJoin(projects, eq(flows.projectId, projects.id))
    .where(eq(projects.workspaceId, workspaceId));

  const out: {
    flow_id: string;
    name: string;
    totals: MetricsTotals;
  }[] = [];

  for (const f of flowRows) {
    const m = await getFlowMetrics(f.id, workspaceId, {
      from,
      to,
      trigger: opts.trigger,
    });
    out.push({ flow_id: f.id, name: f.name, totals: m.totals });
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    flows: out,
  };
}

