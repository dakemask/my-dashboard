import type { ConnectorSide } from "./types";

export const NODE_NAME = "mind-node";
export const NODE_RECT_NAME = "node-rect";
export const NODE_TEXT_NAME = "node-text";
export const NODE_TEXT_HIT_NAME = "node-text-hit";
export const NODE_MOVE_HIT_NAME = "node-move-hit";
export const ARROW_NAME = "mind-arrow";
export const CONNECTOR_NAME = "connector-handle";

export const CONNECTOR_SIDES: ConnectorSide[] = ["top", "right", "bottom", "left"];

export const NODE_STROKE = "#2f3338";
export const SELECTED_STROKE = "#2563eb";
export const SELECTED_SHADOW = "rgba(37, 99, 235, 0.1)";
export const UNSELECTED_STROKE_WIDTH = 0.75;
export const SELECTED_STROKE_WIDTH = 1.25;
export const SELECTED_SHADOW_BLUR = 5;

export const MOVE_HIT_SIZE = 10;
export const MOVE_THRESHOLD = 1.5;
export const RESIZE_VISUAL_MIN_SIZE = 1;
export const GRID_SIZE = 24;
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 2.6;
export const ZOOM_STEP = 1.1;

export const MOVE_HIT_PARTS = ["top", "right", "bottom", "left"] as const;
export type MoveHitPart = (typeof MOVE_HIT_PARTS)[number];
