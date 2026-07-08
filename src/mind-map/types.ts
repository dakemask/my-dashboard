export type ConnectorSide = "top" | "right" | "bottom" | "left";

export interface MindMapEndpoint {
  nodeId: string;
  side: ConnectorSide;
}

export interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  autoWidth: boolean;
}

export interface MindMapArrow {
  id: string;
  from: MindMapEndpoint;
  to: MindMapEndpoint;
}

export interface MindMapData {
  nodes: MindMapNode[];
  arrows: MindMapArrow[];
}

export interface MindMapState {
  sha: string | null;
  data: MindMapData;
  dirty: boolean;
  selection: MindMapSelection;
}

export type MindMapSelection =
  | {
      type: "node";
      id: string;
    }
  | {
      type: "arrow";
      id: string;
    }
  | null;

export interface NodeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  autoWidth?: boolean;
}
