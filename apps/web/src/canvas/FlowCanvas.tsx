import { useCallback, useEffect, useRef } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { BaseNode } from "./nodes/BaseNode";
import { DecisionNode } from "./nodes/DecisionNode";
import { LabeledEdge } from "./edges/LabeledEdge";
import { fromXyflow, toXyflow } from "./graph-adapter";
import type { FlowGraph } from "@awo/graph-schema";

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
};

export function FlowCanvas({ graph, graphEpoch = 0, onGraphChange }: Props) {
  const initial = toXyflow(graph);
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(initial.edges);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Reset internal XYFlow state when API (or parent) loads a different graph.
  useEffect(() => {
    const next = toXyflow(graph);
    setNodes(next.nodes);
    setEdges(next.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only on epoch/id
  }, [graphEpoch, graph.id, setNodes, setEdges]);

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
        const kind =
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
        const next = addEdge(
          {
            ...connection,
            type: "labeled",
            data: { kind, label: "" },
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

  return (
    <div className="awo-canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
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
