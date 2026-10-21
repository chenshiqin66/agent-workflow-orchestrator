import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { EdgeKind, FlowGraph, GraphEdge, GraphNode } from "@awo/graph-schema";

export const EDGE_STROKE: Record<EdgeKind, string> = {
  success: "#3b82f6",
  failure: "#ef4444",
  default: "#94a3b8",
};

export type AwoNodeData = {
  graphType: string;
  config: Record<string, unknown>;
  variant?: string;
  label: string;
  /** UI-only: dynamic breakpoint highlight (not persisted in graph JSON) */
  hasBreakpoint?: boolean;
};

export type AwoEdgeData = {
  kind: EdgeKind;
  label: string;
};

function nodeLabel(n: GraphNode): string {
  const fromConfig = n.config?.label;
  if (typeof fromConfig === "string" && fromConfig.length > 0) return fromConfig;
  return n.type;
}

function xyflowNodeType(n: GraphNode): string {
  if (n.type === "Branch" || n.ui.variant === "decision") return "decision";
  return "base";
}

export function toXyflow(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: xyflowNodeType(n),
    position: { x: n.ui.x, y: n.ui.y },
    data: {
      graphType: n.type,
      config: n.config ?? {},
      variant: n.ui.variant,
      label: nodeLabel(n),
    } satisfies AwoNodeData,
  }));

  const edges: Edge[] = graph.edges.map((e) => {
    const kind = (e.kind ?? "default") as EdgeKind;
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      type: "labeled",
      label: e.label ?? "",
      data: {
        kind,
        label: e.label ?? "",
      } satisfies AwoEdgeData,
      style: {
        stroke: EDGE_STROKE[kind],
        strokeWidth: 2,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: EDGE_STROKE[kind],
      },
    };
  });

  return { nodes, edges };
}

export function fromXyflow(
  nodes: Node[],
  edges: Edge[],
  graphId: string,
  stateSchema: Record<string, unknown> = { type: "object", properties: {} },
): FlowGraph {
  const graphNodes: GraphNode[] = nodes.map((n) => {
    const data = (n.data ?? {}) as Partial<AwoNodeData>;
    let graphType: string | undefined =
      typeof data.graphType === "string" && data.graphType.length > 0
        ? data.graphType
        : undefined;
    // Known XYFlow visual type → Branch; never invent HTTP.
    if (!graphType && n.type === "decision") {
      graphType = "Branch";
    }
    if (!graphType) {
      throw new Error(
        `fromXyflow: node "${n.id}" is missing data.graphType (refusing silent HTTP default)`,
      );
    }
    const config: Record<string, unknown> = { ...(data.config ?? {}) };
    if (typeof data.label === "string" && data.label.length > 0 && data.label !== graphType) {
      config.label = data.label;
    }
    return {
      id: n.id,
      type: graphType,
      config,
      ui: {
        x: n.position.x,
        y: n.position.y,
        ...(data.variant || n.type === "decision"
          ? { variant: data.variant ?? "decision" }
          : {}),
      },
    };
  });

  const graphEdges: GraphEdge[] = edges.map((e) => {
    const data = (e.data ?? {}) as Partial<AwoEdgeData>;
    const kind = (data.kind ?? "default") as EdgeKind;
    const label =
      typeof data.label === "string"
        ? data.label
        : typeof e.label === "string"
          ? e.label
          : "";
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "out",
      target: e.target,
      targetHandle: e.targetHandle ?? "in",
      kind,
      label,
    };
  });

  return {
    id: graphId,
    state_schema: stateSchema,
    nodes: graphNodes,
    edges: graphEdges,
  };
}
