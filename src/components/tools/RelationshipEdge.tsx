import { memo } from "react";
import {
  BaseEdge,
  getSmoothStepPath,
  EdgeLabelRenderer,
  type EdgeProps,
  type Edge,
} from "@xyflow/react";

export interface RelationshipEdgeData extends Record<string, unknown> {
  sourceColumn: string;
  targetColumn: string;
  sourceTable: string;
  targetTable: string;
}

export type RelationshipEdgeType = Edge<RelationshipEdgeData>;

function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps<RelationshipEdgeType>) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? "var(--accent-9)" : "var(--neutral-7)",
          strokeWidth: selected ? 2.5 : 2,
          transition: "stroke 0.15s, stroke-width 0.15s",
        }}
      />

      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-none text-[10px] font-bold font-mono leading-none px-1 py-0.5 rounded bg-[var(--surface-overlay)]"
          style={{
            color: selected ? "var(--accent-9)" : "var(--neutral-11)",
            transform: "translate(-50%, -50%)",
            left: sourceX + 14,
            top: sourceY,
          }}
        >
          *
        </div>
      </EdgeLabelRenderer>

      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-none text-[10px] font-bold font-mono leading-none px-1 py-0.5 rounded bg-[var(--surface-overlay)]"
          style={{
            color: selected ? "var(--accent-9)" : "var(--neutral-11)",
            transform: "translate(-50%, -50%)",
            left: targetX - 14,
            top: targetY,
          }}
        >
          1
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default memo(RelationshipEdge);
