/** Pause-episode key: changes when a new pause begins (new run, reason, or node). */
export function pauseEpisodeKey(run: {
  id: string;
  status: string;
  pauseReason?: string | null;
  checkpoint?: { node_id?: string } | null;
}): string | null {
  if (run.status !== "paused") return null;
  return `${run.id}|${run.pauseReason ?? ""}|${run.checkpoint?.node_id ?? ""}`;
}

export function formatCheckpointState(state: unknown): string {
  return JSON.stringify(state ?? {}, null, 2);
}

export type SeedAction = "clear" | "seed" | "keep";

/**
 * Decide whether StateEditor should replace local textarea text.
 * - clear: left paused
 * - seed: new pause episode, or same episode while not dirty (allow server refresh)
 * - keep: same episode and user has edited, or post-save awaiting stale props to catch up
 */
export function shouldSeedStateEditor(opts: {
  episodeKey: string | null;
  prevEpisodeKey: string | null;
  dirty: boolean;
  /** After PATCH succeeds, true until parent poll returns matching checkpoint.state */
  awaitingServerAck?: boolean;
}): SeedAction {
  if (opts.episodeKey === null) return "clear";
  if (opts.prevEpisodeKey !== opts.episodeKey) return "seed";
  if (opts.dirty) return "keep";
  if (opts.awaitingServerAck) return "keep";
  return "seed";
}

/** True when post-save local fingerprint matches server props (ack complete). */
export function serverAckCaughtUp(
  awaitingServerAck: boolean,
  serverSerialized: string,
  localFingerprint: string | null,
): boolean {
  return (
    awaitingServerAck &&
    localFingerprint !== null &&
    serverSerialized === localFingerprint
  );
}
