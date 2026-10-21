import { useCallback, useState } from "react";
import type { ApiClient, PauseReason, RunDetail } from "../api/client";
import { parseSignalInputPayload } from "./parseSignalInput";

type Props = {
  run: RunDetail;
  client: ApiClient;
  busy?: boolean;
  onDone?: () => void;
  onError?: (msg: string) => void;
};

export function SignalPanel({
  run,
  client,
  busy = false,
  onDone,
  onError,
}: Props) {
  const [inputText, setInputText] = useState("{}");
  const [sending, setSending] = useState(false);

  const reason = (run.pauseReason ?? null) as PauseReason | string | null;
  const nodeId = run.checkpoint?.node_id;

  const send = useCallback(
    async (kind: "approve" | "reject" | "input" | "resume", payload?: unknown) => {
      setSending(true);
      try {
        await client.signalRun(run.id, { kind, payload });
        onDone?.();
      } catch (e) {
        onError?.((e as Error).message);
      } finally {
        setSending(false);
      }
    },
    [client, onDone, onError, run.id],
  );

  if (run.status !== "paused") return null;

  const disabled = busy || sending;

  return (
    <div className="awo-signal" role="region" aria-label="Signal panel">
      <div className="awo-signal__banner">
        已暂停
        {reason ? ` · ${reason}` : ""}
        {nodeId ? ` @ ${nodeId}` : ""}
      </div>

      {reason === "approval" && (
        <div className="awo-signal__actions">
          <button
            type="button"
            className="awo-run-panel__primary"
            disabled={disabled}
            onClick={() => void send("approve")}
          >
            通过
          </button>
          <button
            type="button"
            className="awo-run-panel__secondary"
            disabled={disabled}
            onClick={() => void send("reject")}
          >
            驳回
          </button>
        </div>
      )}

      {reason === "breakpoint" && (
        <div className="awo-signal__actions">
          <button
            type="button"
            className="awo-run-panel__primary"
            disabled={disabled}
            onClick={() => void send("resume")}
          >
            继续 (Resume)
          </button>
        </div>
      )}

      {reason === "input" && (
        <div className="awo-signal__input">
          <label className="awo-run-panel__label" htmlFor="awo-signal-input">
            输入 JSON
          </label>
          <textarea
            id="awo-signal-input"
            className="awo-run-panel__input"
            rows={4}
            spellCheck={false}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={disabled}
          />
          <button
            type="button"
            className="awo-run-panel__primary"
            disabled={disabled}
            onClick={() => {
              let payload: Record<string, unknown>;
              try {
                payload = parseSignalInputPayload(inputText);
              } catch (e) {
                onError?.((e as Error).message);
                return;
              }
              void send("input", payload);
            }}
          >
            提交输入
          </button>
        </div>
      )}
    </div>
  );
}
