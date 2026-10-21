import { describe, it, expect } from "vitest";
import { aggregateRunRows } from "./metrics-service";

describe("aggregateRunRows", () => {
  it("computes success_rate and avg_latency_ms", () => {
    const rows = [
      {
        status: "succeeded",
        startedAt: new Date("2026-10-22T00:00:00Z"),
        finishedAt: new Date("2026-10-22T00:00:02Z"),
        costTokens: 10,
        flowVersionId: "fv1",
        version: 1,
        versionStatus: "published",
      },
      {
        status: "failed",
        startedAt: new Date("2026-10-22T00:00:00Z"),
        finishedAt: new Date("2026-10-22T00:00:01Z"),
        costTokens: 5,
        flowVersionId: "fv1",
        version: 1,
        versionStatus: "published",
      },
    ];
    const agg = aggregateRunRows(rows);
    expect(agg.totals.succeeded).toBe(1);
    expect(agg.totals.failed).toBe(1);
    expect(agg.totals.success_rate).toBeCloseTo(0.5);
    expect(agg.totals.avg_latency_ms).toBeCloseTo(1500);
    expect(agg.totals.sum_cost_tokens).toBe(15);
  });
});
