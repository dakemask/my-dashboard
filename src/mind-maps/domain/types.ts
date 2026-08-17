export type ConnectorSide = "top" | "right" | "bottom" | "left";

export interface MindMapEndpoint {
  readonly nodeId: string;
  readonly side: ConnectorSide;
}

export interface NodeFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MindMapNode extends NodeFrame {
  readonly id: string;
  readonly text: string;
  readonly autoWidth: boolean;
}

export interface MindMapArrow {
  readonly id: string;
  readonly from: MindMapEndpoint;
  readonly to: MindMapEndpoint;
}

/** `path` is the display path without a trailing `.json`. */
export interface MindMapDocument {
  readonly id: string;
  readonly path: string;
  readonly nodes: readonly MindMapNode[];
  readonly arrows: readonly MindMapArrow[];
}

export interface MindMapPayload {
  readonly folders: readonly string[];
  readonly maps: readonly MindMapDocument[];
}

export interface NodePosition {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

export type MindMapEvent =
  | { readonly type: "create-folder"; readonly path: string }
  | { readonly type: "delete-folder"; readonly path: string }
  | {
      readonly type: "restore-folder";
      readonly rootPath: string;
      readonly folders: readonly string[];
      readonly maps: readonly MindMapDocument[];
    }
  | {
      readonly type: "relocate-folder";
      readonly fromPath: string;
      readonly toPath: string;
    }
  | { readonly type: "create-map"; readonly map: MindMapDocument }
  | { readonly type: "delete-map"; readonly mapId: string }
  | { readonly type: "restore-map"; readonly map: MindMapDocument }
  | {
      readonly type: "relocate-map";
      readonly mapId: string;
      readonly path: string;
    }
  | { readonly type: "add-node"; readonly mapId: string; readonly node: MindMapNode }
  | {
      readonly type: "set-node-text";
      readonly mapId: string;
      readonly nodeId: string;
      readonly text: string;
      readonly frame: NodeFrame;
      readonly autoWidth: boolean;
    }
  | {
      readonly type: "set-node-frame";
      readonly mapId: string;
      readonly nodeId: string;
      readonly frame: NodeFrame;
      readonly autoWidth: boolean;
    }
  | {
      readonly type: "move-nodes";
      readonly mapId: string;
      readonly positions: readonly NodePosition[];
    }
  | { readonly type: "add-arrow"; readonly mapId: string; readonly arrow: MindMapArrow }
  | {
      readonly type: "delete-objects";
      readonly mapId: string;
      readonly nodeIds: readonly string[];
      readonly arrowIds: readonly string[];
    }
  | {
      readonly type: "restore-objects";
      readonly mapId: string;
      readonly nodes: readonly MindMapNode[];
      readonly arrows: readonly MindMapArrow[];
    };
