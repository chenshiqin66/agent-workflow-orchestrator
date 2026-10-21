import { describe, expect, it } from "vitest";
import {
  formatCheckpointState,
  pauseEpisodeKey,
  serverAckCaughtUp,
  shouldSeedStateEditor,
} from "./stateEditorSeed";

describe("pauseEpisodeKey", () => {
  it("returns null when not paused", () => {
    expect(
      pauseEpisodeKey({
        id: "r1",
        status: "running",
        pauseReason: "breakpoint",
        checkpoint: { node_id: "n1" },
      }),
    ).toBeNull();
  });

  it("includes run id, pause reason, and node", () => {
    expect(
      pauseEpisodeKey({
        id: "r1",
        status: "paused",
        pauseReason: "breakpoint",
        checkpoint: { node_id: "bp_1" },
      }),
    ).toBe("r1|breakpoint|bp_1");
  });
});

describe("shouldSeedStateEditor", () => {
  it("clears when leaving paused", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: null,
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: true,
      }),
    ).toBe("clear");
  });

  it("seeds on new pause episode even if dirty", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: "r1|approval|ha_1",
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: true,
      }),
    ).toBe("seed");
  });

  it("keeps local edits on same episode when dirty (poll must not reset)", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: "r1|breakpoint|n1",
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: true,
      }),
    ).toBe("keep");
  });

  it("seeds same episode when not dirty so server refresh applies", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: "r1|breakpoint|n1",
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: false,
      }),
    ).toBe("seed");
  });

  it("keeps local text after save while awaiting server ack (stale props must not wipe)", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: "r1|breakpoint|n1",
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: false,
        awaitingServerAck: true,
      }),
    ).toBe("keep");
  });

  it("seeds same episode when not dirty and not awaiting ack", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: "r1|breakpoint|n1",
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: false,
        awaitingServerAck: false,
      }),
    ).toBe("seed");
  });

  it("seeds new pause episode even while awaiting ack", () => {
    expect(
      shouldSeedStateEditor({
        episodeKey: "r1|approval|ha_1",
        prevEpisodeKey: "r1|breakpoint|n1",
        dirty: false,
        awaitingServerAck: true,
      }),
    ).toBe("seed");
  });

});

describe("formatCheckpointState", () => {
  it("pretty-prints objects and empty object for missing", () => {
    expect(formatCheckpointState({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatCheckpointState(undefined)).toBe("{}");
  });
});

describe("serverAckCaughtUp", () => {
  it("is true only when awaiting and server matches local fingerprint", () => {
    expect(serverAckCaughtUp(true, '{\n  "a": 1\n}', '{\n  "a": 1\n}')).toBe(true);
    expect(serverAckCaughtUp(true, "{}", '{\n  "a": 1\n}')).toBe(false);
    expect(serverAckCaughtUp(false, '{\n  "a": 1\n}', '{\n  "a": 1\n}')).toBe(false);
    expect(serverAckCaughtUp(true, "{}", null)).toBe(false);
  });
});
