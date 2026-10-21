import type { FlowGraph } from "@awo/graph-schema";

/** Set Subflow.config.flow_version_id on a graph node (no-op if missing / wrong type). */
export function patchSubflowFlowVersionId(
  graph: FlowGraph,
  nodeId: string,
  flowVersionId: string,
): FlowGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    if (n.id !== nodeId || n.type !== "Subflow") return n;
    changed = true;
    return {
      ...n,
      config: { ...n.config, flow_version_id: flowVersionId },
    };
  });
  return changed ? { ...graph, nodes } : graph;
}
