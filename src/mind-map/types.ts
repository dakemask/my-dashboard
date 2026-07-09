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
  data: MindMapData;
  selection: MindMapSelection;
  currentMapPath: string | null;
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

export type MindMapLibraryEntry = MindMapFolderEntry | MindMapFileEntry;

export interface MindMapFolderEntry {
  kind: "folder";
  name: string;
  path: string;
  children: MindMapLibraryEntry[];
}

export interface MindMapFileEntry {
  kind: "map";
  name: string;
  path: string;
}

export type MindMapLibrarySelection =
  | {
      kind: "folder" | "map";
      path: string;
    }
  | null;
