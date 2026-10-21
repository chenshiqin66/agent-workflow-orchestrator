import { useCallback, useState } from "react";
import type { FlowGraph } from "@awo/graph-schema";
import { api, type ApiClient, type RunStatus } from "../api/client";
import { RunTimeline } from "./RunTimeline";
import { useRunPoll } from "./useRunPoll";
import { SAMPLE_M2_INPUT } from "../sample-m2-graph";

type Props = {
  flowId: string | null;
  publishedVersionId: string | null;
  graph?: FlowGraph | null;
  client?: ApiClient;
  busy?: boolean;
  onStatus?: (msg: string) => void;
};

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
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
  if (status === "running" || status === "queued" || status === "cancel_requested")
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
}: Props) {
  const [inputText, setInputText] = useState(() =>
    JSON.stringify(SAMPLE_M2_INPUT, null, 2),
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const { run, events, error: pollError, polling, reset } = useRunPoll(runId, {
    client,
  });

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
  }, [
    client,
    flowId,
    inputText,
    onStatus,
    publishedVersionId,
    reset,
  ]);

  const onCancel = useCallback(async () => {
    if (!runId) return;
    try {
      await client.cancelRun(runId);
      onStatus?.(`已请求取消 ${runId}`);
    } catch (e) {
      setLocalError((e as Error).message);
    }
  }, [client, onStatus, runId]);

  const status = run?.status ?? null;
  const err = localError ?? pollError;

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
        {runId && status && (status === "queued" || status === "running") && (
          <button
            type="button"
            className="awo-run-panel__secondary"
            onClick={() => void onCancel()}
          >
            取消
          </button>
        )}
      </div>

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
