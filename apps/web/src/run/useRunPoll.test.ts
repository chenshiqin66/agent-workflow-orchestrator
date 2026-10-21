import { describe, it, expect } from "vitest";
import {
  isActiveRunStatus,
  maxEventSeq,
  mergeRunEvents,
  nextPollingState,
} from "./useRunPoll";
import type { RunEvent, RunStatus } from "../api/client";

function ev(seq: number, eventType = "log"): RunEvent {
  return {
    id: `ev_${seq}`,
    runId: "run_1",
    seq,
    nodeId: null,
    eventType,
    payload: {},
    ts: "2026-10-21T14:00:00.000Z",
  };
}

describe("useRunPoll helpers", () => {
  it("isActiveRunStatus covers queued/running/cancel_requested only", () => {
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("cancel_requested")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
    expect(isActiveRunStatus(null)).toBe(false);
  });

  it("mergeRunEvents appends by seq without duplicates", () => {
    const merged = mergeRunEvents([ev(1), ev(2)], [ev(2, "node_finished"), ev(3)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged[1]?.eventType).toBe("node_finished");
  });

  it("maxEventSeq returns 0 for empty", () => {
    expect(maxEventSeq([])).toBe(0);
    expect(maxEventSeq([ev(1), ev(5), ev(3)])).toBe(5);
  });

  it("nextPollingState keeps polling on error when status unknown or active", () => {
    expect(nextPollingState({ fetchOk: false, status: null })).toBe(true);
    expect(nextPollingState({ fetchOk: false, status: undefined })).toBe(true);
    expect(nextPollingState({ fetchOk: false, status: "queued" })).toBe(true);
    expect(nextPollingState({ fetchOk: false, status: "running" })).toBe(true);
    expect(nextPollingState({ fetchOk: false, status: "cancel_requested" })).toBe(
      true,
    );
    expect(nextPollingState({ fetchOk: false, status: "succeeded" })).toBe(false);
    expect(nextPollingState({ fetchOk: false, status: "failed" })).toBe(false);
  });

  it("continues polling after transient failure then success until terminal", () => {
    let polling = true;
    let status: RunStatus | null = null;

    // First tick fails before any status is known — must keep polling
    polling = nextPollingState({ fetchOk: false, status });
    expect(polling).toBe(true);

    // Transient network blip while still running — must keep polling
    status = "running";
    polling = nextPollingState({ fetchOk: false, status });
    expect(polling).toBe(true);

    // Recovery success while still active — keep polling
    polling = nextPollingState({ fetchOk: true, status: "running" });
    expect(polling).toBe(true);

    // Terminal success — stop
    polling = nextPollingState({ fetchOk: true, status: "succeeded" });
    expect(polling).toBe(false);
  });
});
