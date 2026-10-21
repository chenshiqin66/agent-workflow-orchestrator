import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AwoNodeData } from "../graph-adapter";

const VARIANT_CLASS: Record<string, string> = {
  Start: "awo-node--blue",
  End: "awo-node--green",
  HTTP: "awo-node--blue",
  LLM: "awo-node--blue",
  Tool: "awo-node--blue",
  HumanApproval: "awo-node--orange",
  Input: "awo-node--orange",
};

function iconFor(type: string): string {
  switch (type) {
    case "Start":
      return "👤";
    case "End":
      return "💬";
    case "HTTP":
      return "🗄";
    case "LLM":
      return "💡";
    case "HumanApproval":
      return "🎧";
    default:
      return "●";
  }
}

export function BaseNode({ data }: NodeProps) {
  const d = data as AwoNodeData;
  const tone = VARIANT_CLASS[d.graphType] ?? "awo-node--blue";
  const isEnd = d.graphType === "End";
  const isStart = d.graphType === "Start";

  return (
    <div className={`awo-node ${tone}`}>
      {!isStart && <Handle type="target" position={Position.Left} id="in" className="awo-handle" />}
      <div className="awo-node__icon" aria-hidden>
        {iconFor(d.graphType)}
      </div>
      <div className="awo-node__label">{d.label}</div>
      {!isEnd && <Handle type="source" position={Position.Right} id="out" className="awo-handle" />}
      {/* bottom source for failure-style fan-out from non-branch nodes */}
      {!isEnd && !isStart && (
        <Handle type="source" position={Position.Bottom} id="failure" className="awo-handle" />
      )}
    </div>
  );
}
