import { useMemo, useState } from "react";
import type { FlowGraph } from "@awo/graph-schema";
import type { RunEvent } from "../api/client";

type Props = {
  events: RunEvent[];
  graph?: FlowGraph | null;
};

const EVENT_LABELS: Record<string, string> = {
  breakpoint_hit: "断点命中",
  waiting_signal: "等待信号",
  signal_received: "已收信号",
  state_patched: "状态已改",
  run_started: "运行开始",
  run_finished: "运行结束",
  node_started: "节点开始",
  node_finished: "节点完成",
  node_failed: "节点失败",
  emit: "Emit",
  log: "日志",
};

function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

function nodeTypeMap(graph?: FlowGraph | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!graph) return m;
  for (const n of graph.nodes) m.set(n.id, n.type);
  return m;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function durationMs(payload: Record<string, unknown>): number | null {
  const d = payload.duration_ms ?? payload.durationMs ?? payload.duration;
  if (typeof d === "number" && Number.isFinite(d)) return d;
  return null;
}

function hasIo(payload: Record<string, unknown>): boolean {
  return (
    payload.input !== undefined ||
    payload.output !== undefined ||
    payload.error !== undefined ||
    Object.keys(payload).length > 0
  );
}

export function RunTimeline({ events, graph }: Props) {
  const types = useMemo(() => nodeTypeMap(graph), [graph]);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  if (events.length === 0) {
    return (
      <div className="awo-timeline awo-timeline--empty">
        暂无事件 — 试运行后时间线会出现在这里
      </div>
    );
  }

  return (
    <ol className="awo-timeline" aria-label="Run timeline">
      {events.map((e) => {
        const nType = e.nodeId ? types.get(e.nodeId) : undefined;
        const ms = durationMs(e.payload);
        const expanded = openSeq === e.seq;
        const canExpand = hasIo(e.payload);
        return (
          <li key={`${e.seq}-${e.id}`} className="awo-timeline__row">
            <div className="awo-timeline__meta">
              <span className="awo-timeline__seq">#{e.seq}</span>
              <span className="awo-timeline__time">{formatTime(e.ts)}</span>
              <span
                className={`awo-timeline__type awo-timeline__type--${e.eventType}`}
                title={e.eventType}
              >
                {eventLabel(e.eventType)}
              </span>
              {e.nodeId && (
                <span className="awo-timeline__node">
                  {e.nodeId}
                  {nType ? ` · ${nType}` : ""}
                </span>
              )}
              {ms != null && (
                <span className="awo-timeline__dur">{ms} ms</span>
              )}
              {canExpand && (
                <button
                  type="button"
                  className="awo-timeline__toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpenSeq(expanded ? null : e.seq)}
                >
                  {expanded ? "收起" : "IO"}
                </button>
              )}
            </div>
            {expanded && (
              <pre className="awo-timeline__payload">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            )}
          </li>
        );
      })}
    </ol>
  );
}
