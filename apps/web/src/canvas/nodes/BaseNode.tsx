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
  Breakpoint: "awo-node--purple",
  Transform: "awo-node--blue",
  Emit: "awo-node--blue",
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
    case "Input":
      return "⌨️";
    case "Breakpoint":
      return "⛔";
    case "Transform":
      return "🔧";
    case "Emit":
      return "📣";
    default:
      return "●";
  }
}

export function BaseNode({ data }: NodeProps) {
  const d = data as AwoNodeData & { hasBreakpoint?: boolean };
  const tone = VARIANT_CLASS[d.graphType] ?? "awo-node--blue";
  const isEnd = d.graphType === "End";
  const isStart = d.graphType === "Start";
  const isApproval = d.graphType === "HumanApproval";
  const bpClass = d.hasBreakpoint ? " awo-node--breakpoint" : "";

  return (
    <div className={`awo-node ${tone}${bpClass}`}>
      {!isStart && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          className="awo-handle"
        />
      )}
      <div className="awo-node__icon" aria-hidden>
        {iconFor(d.graphType)}
      </div>
      <div className="awo-node__label">{d.label}</div>
      {isApproval ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="success"
            className="awo-handle"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="failure"
            className="awo-handle"
          />
        </>
      ) : (
        <>
          {!isEnd && (
            <Handle
              type="source"
              position={Position.Right}
              id="out"
              className="awo-handle"
            />
          )}
          {!isEnd && !isStart && (
            <Handle
              type="source"
              position={Position.Bottom}
              id="failure"
              className="awo-handle"
            />
          )}
        </>
      )}
    </div>
  );
}
