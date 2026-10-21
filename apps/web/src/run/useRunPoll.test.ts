import { describe, it, expect } from "vitest";
import {
  isActiveRunStatus,
  maxEventSeq,
  mergeRunEvents,
} from "./useRunPoll";
import type { RunEvent } from "../api/client";

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
});
