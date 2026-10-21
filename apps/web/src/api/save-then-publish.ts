import type { FlowGraph } from "@awo/graph-schema";
import type { ApiClient, PublishResult, SaveDraftResult } from "./client";

export type SaveThenPublishResult = {
  saved: SaveDraftResult;
  published: PublishResult;
};

/**
 * Persist the in-memory canvas graph, then publish that draft.
 * If save fails, publish is not called (avoids publishing a stale server draft).
 */
export async function saveThenPublish(
  client: ApiClient,
  flowId: string,
  graph: FlowGraph,
): Promise<SaveThenPublishResult> {
  const saved = await client.saveDraft(flowId, graph);
  const published = await client.publish(flowId);
  return { saved, published };
}
