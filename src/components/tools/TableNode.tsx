import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Key, Link2, Variable, Ban } from "lucide-react";
import type { ERColumn } from "./useERData";

export interface TableNodeData extends Record<string, unknown> {
  id: string;
  schema: string;
  tableName: string;
  displayName: string;
  columns: ERColumn[];
  nodeHeight: number;
  isJunction: boolean;
  connectionType: string;
}

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 36;
const NODE_WIDTH = 240;

function ColumnRow({
  col,
  tableId,
}: {
  col: ERColumn;
  tableId: string;
}) {
  const handleId = `${tableId}:${col.name}`;

  return (
    <div
      className="flex items-center gap-1.5 px-3 text-[11px] leading-none"
      style={{ height: ROW_HEIGHT }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id={handleId}
        style={{
          width: 6,
          height: 6,
          left: -3,
          background: col.isFK ? "var(--accent-9)" : "transparent",
          border: col.isFK ? "2px solid var(--accent-9)" : "none",
        }}
      />

      <span className="w-3.5 shrink-0 flex items-center justify-center">
        {col.isPK ? (
          <Key className="w-3 h-3 text-amber-400" />
        ) : col.isFK ? (
          <Link2 className="w-3 h-3 text-[var(--accent-9)]" />
        ) : (
          <Variable className="w-3 h-3 text-[var(--neutral-9)]" />
        )}
      </span>

      <span className="truncate text-[var(--neutral-12)] flex-1 min-w-0">
        {col.name}
      </span>

      <span className="text-[10px] text-[var(--neutral-11)] truncate max-w-[90px] font-mono">
        {col.type}
      </span>

      {col.nullable && (
        <Ban className="w-2.5 h-2.5 text-[var(--neutral-9)] shrink-0" />
      )}

      <Handle
        type="source"
        position={Position.Right}
        id={handleId}
        style={{
          width: 6,
          height: 6,
          right: -3,
          background: col.isFK ? "var(--accent-9)" : "transparent",
          border: col.isFK ? "2px solid var(--accent-9)" : "none",
        }}
      />
    </div>
  );
}

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { id, displayName, columns, schema, isJunction, nodeHeight } = data;

  return (
    <div
      className="rounded-lg border-2 border-[var(--neutral-6)] bg-[var(--surface-elevated)] shadow-lg overflow-hidden select-none transition-shadow"
      style={{
        width: NODE_WIDTH,
        minHeight: nodeHeight,
      }}
    >
      <div
        className={[
          "flex items-center gap-2 px-3 text-xs font-bold",
          isJunction
            ? "bg-[var(--accent-3)] text-[var(--accent-11)]"
            : "bg-[var(--neutral-3)] text-[var(--neutral-12)]",
        ].join(" ")}
        style={{ height: HEADER_HEIGHT }}
      >
        {schema && (
          <span className="text-[10px] text-[var(--neutral-11)] font-normal">
            {schema}.
          </span>
        )}
        <span className="truncate min-w-0">{displayName}</span>
        {isJunction && (
          <span className="ml-auto text-[9px] uppercase tracking-wider opacity-60">
            junction
          </span>
        )}
      </div>

      <div className="py-0.5">
        {columns.map((col: ERColumn) => (
          <ColumnRow
            key={`${id}:${col.name}`}
            col={col}
            tableId={id}
          />
        ))}
      </div>
    </div>
  );
}

export default memo(TableNode);
