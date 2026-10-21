import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ApiClient,
  type RunDetail,
  type RunEvent,
  type RunStatus,
} from "../api/client";

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "queued",
  "running",
  "cancel_requested",
]);

export const POLL_INTERVAL_MS = 750;

export function isActiveRunStatus(status: RunStatus | null | undefined): boolean {
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

/**
 * Decide whether the poll interval should stay armed after a tick.
 * - On success: only while status is active.
 * - On fetch/parse error: keep polling while status is still active OR still unknown
 *   (do not stop forever on a transient failure).
 */
export function nextPollingState(args: {
  fetchOk: boolean;
  status: RunStatus | null | undefined;
}): boolean {
  if (args.fetchOk) {
    return isActiveRunStatus(args.status);
  }
  return args.status == null || isActiveRunStatus(args.status);
}

/** Merge events by seq ascending; later duplicates with same seq replace earlier. */
export function mergeRunEvents(
  existing: RunEvent[],
  incoming: RunEvent[],
): RunEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, RunEvent>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function maxEventSeq(events: RunEvent[]): number {
  let max = 0;
  for (const e of events) {
    if (e.seq > max) max = e.seq;
  }
  return max;
}

type Options = {
  client?: ApiClient;
  intervalMs?: number;
};

export function useRunPoll(runId: string | null, options: Options = {}) {
  const client = options.client ?? api;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;

  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const runRef = useRef(run);
  runRef.current = run;

  const tick = useCallback(async () => {
    if (!runId) return;
    try {
      const detail = await client.getRun(runId);
      setRun(detail);
      const after = maxEventSeq(eventsRef.current);
      const { events: next } = await client.listRunEvents(
        runId,
        after > 0 ? after : undefined,
      );
      if (next.length > 0) {
        setEvents((prev) => mergeRunEvents(prev, next));
      }
      setError(null);
      setPolling(nextPollingState({ fetchOk: true, status: detail.status }));
    } catch (e) {
      setError((e as Error).message);
      setPolling(
        nextPollingState({
          fetchOk: false,
          status: runRef.current?.status,
        }),
      );
    }
  }, [client, runId]);

  // Reset when runId changes
  useEffect(() => {
    setRun(null);
    setEvents([]);
    setError(null);
    setPolling(false);
    if (!runId) return;
    setPolling(true);
    void tick();
  }, [runId, tick]);

  useEffect(() => {
    if (!runId || !polling) return;
    const id = window.setInterval(() => {
      void tick();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [runId, polling, intervalMs, tick]);

  const reset = useCallback(() => {
    setRun(null);
    setEvents([]);
    setError(null);
    setPolling(false);
  }, []);

  return { run, events, error, polling, refresh: tick, reset };
}
