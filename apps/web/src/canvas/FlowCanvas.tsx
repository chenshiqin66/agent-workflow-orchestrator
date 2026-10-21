import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
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
  onGraphChange?: (graph: FlowGraph) => void;
};

export function FlowCanvas({ graph, onGraphChange }: Props) {
  const initial = useMemo(() => toXyflow(graph), [graph]);
  const [nodes, , onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  const emit = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      onGraphChange?.(fromXyflow(nextNodes, nextEdges, graph.id, graph.state_schema));
    },
    [graph.id, graph.state_schema, onGraphChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => {
        const next = addEdge(
          {
            ...connection,
            type: "labeled",
            data: { kind: "default", label: "" },
            style: { stroke: "#94a3b8", strokeWidth: 2 },
          },
          eds,
        );
        emit(nodes, next);
        return next;
      });
    },
    [emit, nodes, setEdges],
  );

  const handleNodesChange: typeof onNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const handleEdgesChange: typeof onEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
    },
    [onEdgesChange],
  );

  const onNodeDragStop = useCallback(() => {
    emit(nodes, edges);
  }, [emit, nodes, edges]);

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
