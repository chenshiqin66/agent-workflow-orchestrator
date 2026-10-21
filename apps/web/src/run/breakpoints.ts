import type { ApiClient } from "../api/client";

/**
 * Toggle one node breakpoint using the server list as source of truth.
 * GET → toggle → PUT → GET so concurrent UI surfaces never wipe each other.
 */
export async function toggleBreakpointOnServer(
  client: Pick<ApiClient, "getBreakpoints" | "putBreakpoints">,
  runId: string,
  nodeId: string,
): Promise<string[]> {
  const current = await client.getBreakpoints(runId);
  const set = new Set(current.node_ids);
  if (set.has(nodeId)) set.delete(nodeId);
  else set.add(nodeId);
  const next = [...set].sort();
  await client.putBreakpoints(runId, next);
  const refreshed = await client.getBreakpoints(runId);
  return refreshed.node_ids;
}
