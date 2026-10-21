import { useCallback, useState } from "react";
import type { ApiClient, FlowMetrics } from "../api/client";

type Props = {
  client: ApiClient;
  flowId: string | null;
  onStatus?: (msg: string) => void;
};

export function MetricsPanel({ client, flowId, onStatus }: Props) {
  const [metrics, setMetrics] = useState<FlowMetrics | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!flowId) {
      onStatus?.("请先打开流程再查看指标");
      return;
    }
    setBusy(true);
    try {
      const m = await client.getFlowMetrics(flowId);
      setMetrics(m);
      onStatus?.(
        `指标已刷新：成功率 ${(m.totals.success_rate * 100).toFixed(1)}%`,
      );
    } catch (e) {
      onStatus?.(`指标加载失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [client, flowId, onStatus]);

  const t = metrics?.totals;

  return (
    <section className="awo-m5-panel">
      <h3>流程指标</h3>
      <button type="button" disabled={busy || !flowId} onClick={() => void refresh()}>
        刷新指标
      </button>
      {!flowId ? (
        <p className="awo-m5-muted">打开流程后可查看指标</p>
      ) : t ? (
        <dl className="awo-m5-metrics">
          <div>
            <dt>runs</dt>
            <dd>{t.runs}</dd>
          </div>
          <div>
            <dt>success_rate</dt>
            <dd>{(t.success_rate * 100).toFixed(1)}%</dd>
          </div>
          <div>
            <dt>avg_latency_ms</dt>
            <dd>{t.avg_latency_ms ?? "—"}</dd>
          </div>
          <div>
            <dt>sum_cost_tokens</dt>
            <dd>{t.sum_cost_tokens}</dd>
          </div>
        </dl>
      ) : (
        <p className="awo-m5-muted">点击刷新加载指标</p>
      )}
    </section>
  );
}
