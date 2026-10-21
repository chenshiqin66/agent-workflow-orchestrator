import type { FlowGraph, GraphEdge, GraphNode } from "@awo/graph-schema";

export type ExpandErrorCode =
  | "subflow_missing_version"
  | "subflow_not_published"
  | "subflow_depth_exceeded"
  | "subflow_cycle"
  | "subflow_invalid_child"
  | "subflow_missing_config";

export class SubflowExpandError extends Error {
  code: ExpandErrorCode;
  details?: Record<string, unknown>;
  constructor(
    code: ExpandErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SubflowExpandError";
    this.code = code;
    this.details = details;
  }
}

function prefixId(prefix: string, id: string): string {
  return `${prefix}__${id}`;
}

export async function expandSubflows(
  graph: FlowGraph,
  opts: {
    resolvePublished: (flowVersionId: string) => Promise<{
      graph: FlowGraph;
      status: string;
      workspaceOk: boolean;
    } | null>;
    maxDepth?: number;
    _stack?: string[];
    _depth?: number;
  },
): Promise<FlowGraph> {
  const maxDepth = opts.maxDepth ?? 3;
  const depth = opts._depth ?? 0;
  const stack = opts._stack ?? [];
  if (depth > maxDepth) {
    throw new SubflowExpandError(
      "subflow_depth_exceeded",
      `max depth ${maxDepth}`,
      { depth, maxDepth },
    );
  }

  const nodes: GraphNode[] = [];
  const replacements: {
    subflowId: string;
    startId: string;
    endId: string;
    childNodes: GraphNode[];
    childEdges: GraphEdge[];
  }[] = [];

  for (const node of graph.nodes) {
    if (node.type !== "Subflow") {
      nodes.push(node);
      continue;
    }
    const fvId = String(
      (node.config as { flow_version_id?: unknown }).flow_version_id ?? "",
    );
    if (!fvId) {
      throw new SubflowExpandError(
        "subflow_missing_config",
        `node ${node.id} missing flow_version_id`,
        { node_id: node.id },
      );
    }
    if (stack.includes(fvId)) {
      throw new SubflowExpandError("subflow_cycle", `cycle at ${fvId}`, {
        flow_version_id: fvId,
      });
    }
    const resolved = await opts.resolvePublished(fvId);
    if (!resolved || !resolved.workspaceOk) {
      throw new SubflowExpandError(
        "subflow_missing_version",
        `unknown ${fvId}`,
        { flow_version_id: fvId },
      );
    }
    if (resolved.status !== "published") {
      throw new SubflowExpandError(
        "subflow_not_published",
        `${fvId} not published`,
        { flow_version_id: fvId },
      );
    }
    // Validate Start/End on the child graph *before* flattening nested
    // Subflows — nested expand leaves multiple Start/End nodes in the
    // flattened child, which must not fail this check.
    const starts = resolved.graph.nodes.filter((n) => n.type === "Start");
    const ends = resolved.graph.nodes.filter((n) => n.type === "End");
    if (starts.length !== 1 || ends.length !== 1) {
      throw new SubflowExpandError(
        "subflow_invalid_child",
        "child needs exactly one Start and one End",
        { flow_version_id: fvId },
      );
    }
    const expandedChild = await expandSubflows(resolved.graph, {
      ...opts,
      _stack: [...stack, fvId],
      _depth: depth + 1,
    });
    const childNodes = expandedChild.nodes.map((n) => ({
      ...n,
      id: prefixId(node.id, n.id),
    }));
    const childEdges = expandedChild.edges.map((e) => ({
      ...e,
      id: prefixId(node.id, e.id),
      source: prefixId(node.id, e.source),
      target: prefixId(node.id, e.target),
    }));
    replacements.push({
      subflowId: node.id,
      startId: prefixId(node.id, starts[0]!.id),
      endId: prefixId(node.id, ends[0]!.id),
      childNodes,
      childEdges,
    });
  }

  const removed = new Set(replacements.map((r) => r.subflowId));
  let nextEdges: GraphEdge[] = graph.edges.map((e) => ({ ...e }));
  for (const rep of replacements) {
    nodes.push(...rep.childNodes);
    nextEdges = nextEdges.map((e) => {
      let source = e.source;
      let target = e.target;
      if (target === rep.subflowId) target = rep.startId;
      if (source === rep.subflowId) source = rep.endId;
      return { ...e, source, target };
    });
    nextEdges = [...nextEdges, ...rep.childEdges];
  }

  nextEdges = nextEdges.filter(
    (e) => !removed.has(e.source) && !removed.has(e.target),
  );

  return {
    ...graph,
    nodes,
    edges: nextEdges,
  };
}
