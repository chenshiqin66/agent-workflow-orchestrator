import { describe, expect, it, vi } from "vitest";
import { toggleBreakpointOnServer } from "./breakpoints";

describe("toggleBreakpointOnServer", () => {
  it("GETs current list, toggles, PUTs, then re-GETs (never uses stale local list)", async () => {
    const getBreakpoints = vi
      .fn()
      .mockResolvedValueOnce({ node_ids: ["a"] }) // pre-toggle
      .mockResolvedValueOnce({ node_ids: ["a", "b"] }); // post-toggle refresh
    const putBreakpoints = vi
      .fn()
      .mockResolvedValue({ node_ids: ["a", "b"] });

    const result = await toggleBreakpointOnServer(
      { getBreakpoints, putBreakpoints },
      "run_1",
      "b",
    );

    expect(getBreakpoints).toHaveBeenCalledTimes(2);
    expect(getBreakpoints).toHaveBeenNthCalledWith(1, "run_1");
    expect(putBreakpoints).toHaveBeenCalledWith("run_1", ["a", "b"]);
    expect(getBreakpoints).toHaveBeenNthCalledWith(2, "run_1");
    expect(result).toEqual(["a", "b"]);
  });

  it("removes an existing breakpoint without wiping siblings", async () => {
    const getBreakpoints = vi
      .fn()
      .mockResolvedValueOnce({ node_ids: ["a", "b", "c"] })
      .mockResolvedValueOnce({ node_ids: ["a", "c"] });
    const putBreakpoints = vi.fn().mockResolvedValue({ node_ids: ["a", "c"] });

    const result = await toggleBreakpointOnServer(
      { getBreakpoints, putBreakpoints },
      "run_1",
      "b",
    );

    expect(putBreakpoints).toHaveBeenCalledWith("run_1", ["a", "c"]);
    expect(result).toEqual(["a", "c"]);
  });
});
