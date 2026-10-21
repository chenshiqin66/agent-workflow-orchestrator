import { useCallback, useEffect, useState } from "react";
import type { FlowGraph } from "@awo/graph-schema";
import { api, type ApiClient, type RunStatus } from "../api/client";
import { RunTimeline } from "./RunTimeline";
import { SignalPanel } from "./SignalPanel";
import { StateEditor } from "./StateEditor";
import { useRunPoll } from "./useRunPoll";
import { SAMPLE_M2_INPUT } from "../sample-m2-graph";
import { SAMPLE_M3_INPUT } from "../sample-m3-graph";

type Props = {
  flowId: string | null;
  publishedVersionId: string | null;
  graph?: FlowGraph | null;
  client?: ApiClient;
  busy?: boolean;
  onStatus?: (msg: string) => void;
  /** Selected canvas node id for breakpoint toggle */
  selectedNodeId?: string | null;
  /** Shared breakpoint list (owned by App; single source of truth) */
  breakpointNodeIds?: string[];
  /** Toggle via App (GET→toggle→PUT→GET); canvas + panel must share this */
  onToggleBreakpoint?: (nodeId: string) => void | Promise<void>;
  /** Prefer M3 sample input when true */
  preferM3Input?: boolean;
  /** Notify parent when active run id changes (for canvas BP toggle) */
  onRunIdChange?: (runId: string | null) => void;
};

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  cancel_requested: "取消中",
};

function badgeClass(status: RunStatus | null): string {
  if (!status) return "awo-run-badge";
  if (status === "succeeded") return "awo-run-badge awo-run-badge--ok";
  if (status === "failed" || status === "cancelled")
    return "awo-run-badge awo-run-badge--err";
  if (status === "paused") return "awo-run-badge awo-run-badge--paused";
  if (
    status === "running" ||
    status === "queued" ||
    status === "cancel_requested"
  )
    return "awo-run-badge awo-run-badge--active";
  return "awo-run-badge";
}

export function TestRunPanel({
  flowId,
  publishedVersionId,
  graph,
  client = api,
  busy = false,
  onStatus,
  selectedNodeId = null,
  breakpointNodeIds = [],
  onToggleBreakpoint,
  preferM3Input = false,
  onRunIdChange,
}: Props) {
  const [inputText, setInputText] = useState(() =>
    JSON.stringify(preferM3Input ? SAMPLE_M3_INPUT : SAMPLE_M2_INPUT, null, 2),
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [bpBusy, setBpBusy] = useState(false);

  const {
    run,
    events,
    error: pollError,
    polling,
    refresh,
    reset,
  } = useRunPoll(runId, { client });

  useEffect(() => {
    onRunIdChange?.(runId);
  }, [onRunIdChange, runId]);

  const canRun =
    Boolean(flowId) && Boolean(publishedVersionId) && !busy && !starting;

  const onStart = useCallback(async () => {
    if (!flowId || !publishedVersionId) {
      setLocalError("请先发布流程后再试运行");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(inputText);
    } catch {
      setLocalError("输入必须是合法 JSON 对象");
      return;
    }
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      setLocalError("input 必须是 JSON 对象");
      return;
    }

    setStarting(true);
    setLocalError(null);
    reset();
    setRunId(null);
    try {
      const created = await client.createTestRun(flowId, input);
      setRunId(created.id);
      onStatus?.(
        `试运行已创建 ${created.id}（${STATUS_LABEL[created.status] ?? created.status}）`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      setLocalError(msg);
      onStatus?.(`试运行失败: ${msg}`);
    } finally {
      setStarting(false);
    }
  }, [client, flowId, inputText, onStatus, publishedVersionId, reset]);

  const onCancel = useCallback(async () => {
    if (!runId) return;
    try {
      await client.cancelRun(runId);
      onStatus?.(`已请求取消 ${runId}`);
      await refresh();
    } catch (e) {
      setLocalError((e as Error).message);
    }
  }, [client, onStatus, refresh, runId]);

  const onPanelToggleBreakpoint = useCallback(async () => {
    if (!runId || !selectedNodeId) {
      setLocalError("请先试运行并选中画布节点，再切换断点");
      return;
    }
    if (!onToggleBreakpoint) return;
    setBpBusy(true);
    setLocalError(null);
    try {
      await onToggleBreakpoint(selectedNodeId);
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBpBusy(false);
    }
  }, [onToggleBreakpoint, runId, selectedNodeId]);

  const status = run?.status ?? null;
  const err = localError ?? pollError;
  const canCancel =
    !!runId &&
    !!status &&
    (status === "queued" ||
      status === "running" ||
      status === "paused" ||
      status === "cancel_requested");

  return (
    <aside className="awo-run-panel" aria-label="Test run panel">
      <div className="awo-run-panel__head">
        <h2 className="awo-run-panel__title">试运行</h2>
        {!publishedVersionId && (
          <span className="awo-run-panel__hint">需先发布版本</span>
        )}
      </div>

      <label className="awo-run-panel__label" htmlFor="awo-run-input">
        输入 JSON
      </label>
      <textarea
        id="awo-run-input"
        className="awo-run-panel__input"
        rows={5}
        spellCheck={false}
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        disabled={starting}
      />

      <div className="awo-run-panel__actions">
        <button
          type="button"
          className="awo-run-panel__primary"
          disabled={!canRun}
          onClick={() => void onStart()}
        >
          {starting ? "启动中…" : "试运行"}
        </button>
        {canCancel && (
          <button
            type="button"
            className="awo-run-panel__secondary"
            onClick={() => void onCancel()}
          >
            取消
          </button>
        )}
        <button
          type="button"
          className="awo-run-panel__secondary awo-run-panel__bp"
          disabled={!runId || !selectedNodeId || bpBusy || !onToggleBreakpoint}
          onClick={() => void onPanelToggleBreakpoint()}
          title={
            selectedNodeId
              ? `切换断点: ${selectedNodeId}`
              : "先选中画布节点"
          }
        >
          {selectedNodeId && breakpointNodeIds.includes(selectedNodeId)
            ? "清除断点"
            : "设断点"}
        </button>
      </div>

      {selectedNodeId && (
        <div className="awo-run-panel__hint-line">
          选中节点: <code>{selectedNodeId}</code>
          {breakpointNodeIds.includes(selectedNodeId) ? " · 有断点" : ""}
        </div>
      )}

      {(runId || status) && (
        <div className="awo-run-panel__status-row">
          {runId && (
            <code className="awo-run-panel__run-id" title={runId}>
              {runId}
            </code>
          )}
          {status && (
            <span className={badgeClass(status)}>
              {STATUS_LABEL[status] ?? status}
              {polling ? " · 轮询中" : ""}
            </span>
          )}
        </div>
      )}

      {run && status === "paused" && (
        <>
          <SignalPanel
            run={run}
            client={client}
            busy={busy || starting}
            onDone={() => {
              setLocalError(null);
              onStatus?.("已发送信号，继续轮询…");
              void refresh();
            }}
            onError={(msg) => setLocalError(msg)}
          />
          <StateEditor
            run={run}
            client={client}
            busy={busy || starting}
            onDone={() => {
              setLocalError(null);
              onStatus?.("state 已保存");
              void refresh();
            }}
            onError={(msg) => setLocalError(msg)}
          />
        </>
      )}

      {err && (
        <div className="awo-run-panel__error" role="alert">
          {err}
        </div>
      )}

      <h3 className="awo-run-panel__subtitle">运行时间线</h3>
      <RunTimeline events={events} graph={graph} />
    </aside>
  );
}
