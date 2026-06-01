import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../../styles/erd.css";
import TableNode, { type TableNodeData } from "./TableNode";
import RelationshipEdge, { type RelationshipEdgeData } from "./RelationshipEdge";

const nodeTypes: NodeTypes = {
  tableNode: TableNode,
};

const edgeTypes: EdgeTypes = {
  relationshipEdge: RelationshipEdge,
};

interface ERDCanvasProps {
  initialNodes: Node<TableNodeData>[];
  initialEdges: Edge<RelationshipEdgeData>[];
}

function FitViewHelper() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    requestAnimationFrame(() => fitView({ padding: 0.3, duration: 200 }));
  });
  return null;
}

function ERDFlow({ initialNodes, initialEdges }: ERDCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const { nodeColor, nodeStroke, bgColor } = useMemo(() => {
    const isDark =
      document.documentElement.classList.contains("dark") ||
      document.documentElement.getAttribute("data-theme") === "dark";
    return {
      nodeColor: isDark ? "#272a2d" : "#e7e8ec",
      nodeStroke: isDark ? "#43484e" : "#cdced7",
      bgColor: isDark ? "#111113" : "#f9f9fb",
    };
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      minZoom={0.1}
      maxZoom={4}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={null}
    >
      <FitViewHelper />
      <Controls showInteractive={false} className="erd-controls" />
      <MiniMap
        nodeStrokeColor={nodeStroke}
        nodeColor={nodeColor}
        nodeBorderRadius={4}
        maskColor={bgColor}
        style={{ backgroundColor: bgColor }}
        pannable
        zoomable
      />
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color={nodeStroke}
      />
    </ReactFlow>
  );
}

export function ERDCanvas({ initialNodes, initialEdges }: ERDCanvasProps) {
  return (
    <ReactFlowProvider>
      <ERDFlow initialNodes={initialNodes} initialEdges={initialEdges} />
    </ReactFlowProvider>
  );
}
