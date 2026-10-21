import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import type { AwoEdgeData } from "../graph-adapter";
import { EDGE_STROKE } from "../graph-adapter";

export function LabeledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
  markerEnd,
  selected,
}: EdgeProps) {
  const d = (data ?? {}) as Partial<AwoEdgeData>;
  const kind = d.kind ?? "default";
  const label = d.label ?? "";
  const stroke = EDGE_STROKE[kind];
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ ...style, stroke, strokeWidth: selected ? 3 : 2 }}
      />
      {(label || selected) ? (
        <EdgeLabelRenderer>
          <div
            className={`awo-edge-label awo-edge-label--${kind}${selected ? " awo-edge-label--selected" : ""} nodrag nopan`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {label || (selected ? "（选中后可编辑标签）" : "")}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
