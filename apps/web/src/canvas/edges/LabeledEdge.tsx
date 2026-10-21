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
        style={{ ...style, stroke, strokeWidth: 2 }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={`awo-edge-label awo-edge-label--${kind} nodrag nopan`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
