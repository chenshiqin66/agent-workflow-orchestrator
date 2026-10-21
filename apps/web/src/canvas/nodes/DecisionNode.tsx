import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AwoNodeData } from "../graph-adapter";

export function DecisionNode({ data }: NodeProps) {
  const d = data as AwoNodeData & { hasBreakpoint?: boolean };
  const bpClass = d.hasBreakpoint ? " awo-node--breakpoint" : "";

  return (
    <div className={`awo-decision${bpClass}`}>
      <div className="awo-decision__diamond">
        <Handle type="target" position={Position.Left} id="in" className="awo-handle awo-handle--diamond" />
        <Handle type="source" position={Position.Right} id="success" className="awo-handle awo-handle--diamond" />
        <Handle type="source" position={Position.Bottom} id="failure" className="awo-handle awo-handle--diamond" />
        <Handle type="source" position={Position.Top} id="out" className="awo-handle awo-handle--diamond" />
        <div className="awo-decision__inner">
          <span className="awo-decision__icon" aria-hidden>
            ⚖
          </span>
          <span className="awo-decision__label">{d.label}</span>
        </div>
      </div>
    </div>
  );
}
