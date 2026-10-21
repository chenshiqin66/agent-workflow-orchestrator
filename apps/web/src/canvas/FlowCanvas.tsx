import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { BaseNode } from "./nodes/BaseNode";
import { DecisionNode } from "./nodes/DecisionNode";
import { LabeledEdge } from "./edges/LabeledEdge";
import { fromXyflow, toXyflow, type AwoEdgeData } from "./graph-adapter";
import type { EdgeKind, FlowGraph } from "@awo/graph-schema";

const nodeTypes = {
  base: BaseNode,
  decision: DecisionNode,
};

const edgeTypes = {
  labeled: LabeledEdge,
};

type Props = {
  graph: FlowGraph;
  /** Bump when graph is loaded/replaced from API so XYFlow state resets. */
  graphEpoch?: number;
  onGraphChange?: (graph: FlowGraph) => void;
  /** Active dynamic breakpoint node ids for highlight */
  breakpointNodeIds?: string[];
  /** Selected canvas node id (for breakpoint toggle in run panel) */
  onSelectedNodeChange?: (nodeId: string | null) => void;
  /** Right-click a node to toggle breakpoint when a run is active */
  onToggleBreakpoint?: (nodeId: string) => void;
};

function defaultLabelForKind(kind: EdgeKind): string {
  if (kind === "success") return "查询成功";
  if (kind === "failure") return "查询失败";
  return "";
}

export function FlowCanvas({
  graph,
  graphEpoch = 0,
  onGraphChange,
  breakpointNodeIds = [],
  onSelectedNodeChange,
  onToggleBreakpoint,
}: Props) {
  const initial = toXyflow(graph);
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(initial.edges);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Reset internal XYFlow state when API (or parent) loads a different graph.
  useEffect(() => {
    const next = toXyflow(graph);
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only on epoch/id
  }, [graphEpoch, graph.id, setNodes, setEdges]);

  // Apply breakpoint highlight without resetting positions.
  useEffect(() => {
    const set = new Set(breakpointNodeIds);
    setNodes((nds) =>
      nds.map((n) => {
        const data = (n.data ?? {}) as Record<string, unknown>;
        const nextHas = set.has(n.id);
        if (Boolean(data.hasBreakpoint) === nextHas) return n;
        return { ...n, data: { ...data, hasBreakpoint: nextHas } };
      }),
    );
  }, [breakpointNodeIds, graphEpoch, setNodes]);

  const emit = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      onGraphChange?.(
        fromXyflow(nextNodes, nextEdges, graph.id, graph.state_schema),
      );
    },
    [graph.id, graph.state_schema, onGraphChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => {
        const kind: EdgeKind =
          connection.sourceHandle === "failure"
            ? "failure"
            : connection.sourceHandle === "success"
              ? "success"
              : "default";
        const stroke =
          kind === "failure"
            ? "#ef4444"
            : kind === "success"
              ? "#3b82f6"
              : "#94a3b8";
        let label = defaultLabelForKind(kind);
        // Prompt when connecting from Branch success/failure handles so labels are set interactively.
        if (kind === "success" || kind === "failure") {
          const entered =
            typeof window !== "undefined"
              ? window.prompt(`边标签（${kind}）`, label)
              : label;
          if (entered === null) {
            // Cancel connect
            return eds;
          }
          label = entered.trim();
        }
        const next = addEdge(
          {
            ...connection,
            type: "labeled",
            data: { kind, label } satisfies AwoEdgeData,
            label,
            style: { stroke, strokeWidth: 2 },
          },
          eds,
        );
        emit(nodesRef.current, next);
        return next;
      });
    },
    [emit, setEdges],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChangeInternal(changes);
      const structural = changes.some(
        (c) => c.type === "remove" || c.type === "add",
      );
      if (structural) {
        const next = applyNodeChanges(changes, nodesRef.current);
        emit(next, edgesRef.current);
      }
    },
    [emit, onNodesChangeInternal],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChangeInternal(changes);
      const structural = changes.some(
        (c) => c.type === "remove" || c.type === "add",
      );
      if (structural) {
        const next = applyEdgeChanges(changes, edgesRef.current);
        emit(nodesRef.current, next);
      }
    },
    [emit, onEdgesChangeInternal],
  );

  const onNodeDragStop = useCallback(() => {
    emit(nodesRef.current, edgesRef.current);
  }, [emit]);

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      setSelectedEdgeId(params.edges[0]?.id ?? null);
      onSelectedNodeChange?.(params.nodes[0]?.id ?? null);
    },
    [onSelectedNodeChange],
  );

  const onNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: Node) => {
      if (!onToggleBreakpoint) return;
      event.preventDefault();
      onToggleBreakpoint(node.id);
    },
    [onToggleBreakpoint],
  );

  const selectedEdge = edges.find((e) => e.id === selectedEdgeId);
  const selectedLabel =
    selectedEdge != null
      ? ((selectedEdge.data as AwoEdgeData | undefined)?.label ??
        (typeof selectedEdge.label === "string" ? selectedEdge.label : "") ??
        "")
      : "";

  const onSelectedLabelChange = (value: string) => {
    if (!selectedEdgeId) return;
    setEdges((eds) => {
      const next = eds.map((e) => {
        if (e.id !== selectedEdgeId) return e;
        const prev = (e.data ?? {}) as AwoEdgeData;
        return {
          ...e,
          label: value,
          data: { ...prev, label: value } satisfies AwoEdgeData,
        };
      });
      emit(nodesRef.current, next);
      return next;
    });
  };

  return (
    <div className="awo-canvas-wrap">
      {selectedEdgeId ? (
        <div className="awo-edge-editor" role="group" aria-label="边标签编辑">
          <label>
            边标签
            <input
              type="text"
              value={selectedLabel}
              onChange={(ev) => onSelectedLabelChange(ev.target.value)}
              placeholder="例如：查询成功"
            />
          </label>
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onNodeContextMenu={onNodeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} color="#c7dff5" />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
