import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient, RunDetail } from "../api/client";
import {
  formatCheckpointState,
  pauseEpisodeKey,
  shouldSeedStateEditor,
} from "./stateEditorSeed";

type Props = {
  run: RunDetail;
  client: ApiClient;
  busy?: boolean;
  onDone?: () => void;
  onError?: (msg: string) => void;
};

export function StateEditor({
  run,
  client,
  busy = false,
  onDone,
  onError,
}: Props) {
  const [text, setText] = useState("{}");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const episodeKeyRef = useRef<string | null>(null);

  const episodeKey = pauseEpisodeKey(run);
  // Stabilize against poll object-identity churn on checkpoint.state
  const serializedState = useMemo(
    () => formatCheckpointState(run.checkpoint?.state),
    [run.checkpoint?.state],
  );

  useEffect(() => {
    const action = shouldSeedStateEditor({
      episodeKey,
      prevEpisodeKey: episodeKeyRef.current,
      dirty,
    });
    if (action === "keep") return;
    episodeKeyRef.current = episodeKey;
    if (action === "clear") {
      setDirty(false);
      setText("{}");
      return;
    }
    setDirty(false);
    setText(serializedState);
  }, [episodeKey, serializedState, dirty]);

  if (run.status !== "paused") return null;

  const onSave = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      onError?.("state 必须是合法 JSON 对象");
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      onError?.("state 必须是 JSON 对象");
      return;
    }
    setSaving(true);
    try {
      await client.patchRunState(run.id, {
        state: parsed as Record<string, unknown>,
      });
      setDirty(false);
      onDone?.();
    } catch (e) {
      onError?.((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="awo-state-editor" role="region" aria-label="State editor">
      <label className="awo-run-panel__label" htmlFor="awo-state-json">
        Checkpoint state
      </label>
      <textarea
        id="awo-state-json"
        className="awo-run-panel__input"
        rows={6}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setDirty(true);
          setText(e.target.value);
        }}
        disabled={busy || saving}
      />
      <button
        type="button"
        className="awo-run-panel__primary"
        disabled={busy || saving}
        onClick={() => void onSave()}
      >
        {saving ? "保存中…" : "保存 state"}
      </button>
    </div>
  );
}
