import Konva from "konva";
import {
  MOVE_HIT_PARTS,
  MOVE_HIT_SIZE,
  NODE_MOVE_HIT_NAME,
  NODE_NAME,
  NODE_RECT_NAME,
  NODE_STROKE,
  NODE_TEXT_HIT_NAME,
  NODE_TEXT_NAME,
  SELECTED_SHADOW,
  SELECTED_SHADOW_BLUR,
  SELECTED_STROKE,
  SELECTED_STROKE_WIDTH,
  UNSELECTED_STROKE_WIDTH,
  type MoveHitPart,
} from "./canvasConstants";
import {
  TEXT_FONT_FAMILY,
  TEXT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING,
} from "./textLayout";
import type { ConnectorSide, MindMapNode } from "./types";

export interface NodeShapeParts {
  group: Konva.Group;
  textHit: Konva.Rect;
  moveHits: Konva.Rect[];
}

export function createNodeShape(node: MindMapNode, selected: boolean): NodeShapeParts {
  const group = new Konva.Group({
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    draggable: false,
    name: NODE_NAME,
  });
  group.setAttr("nodeId", node.id);

  const rect = new Konva.Rect({
    width: node.width,
    height: node.height,
    fill: "#ffffff",
    stroke: selected ? SELECTED_STROKE : NODE_STROKE,
    strokeWidth: selected ? SELECTED_STROKE_WIDTH : UNSELECTED_STROKE_WIDTH,
    cornerRadius: 0,
    name: NODE_RECT_NAME,
    shadowColor: selected ? SELECTED_SHADOW : "transparent",
    shadowBlur: selected ? SELECTED_SHADOW_BLUR : 0,
  });
  const textHit = new Konva.Rect({
    x: TEXT_PADDING,
    y: TEXT_PADDING,
    width: Math.max(1, node.width - TEXT_PADDING * 2),
    height: Math.max(1, node.height - TEXT_PADDING * 2),
    fill: "rgba(255, 255, 255, 0.01)",
    name: NODE_TEXT_HIT_NAME,
  });
  const moveHits = createMoveHitRects(node.width, node.height);
  const text = new Konva.Text({
    x: TEXT_PADDING,
    y: TEXT_PADDING,
    width: Math.max(1, node.width - TEXT_PADDING * 2),
    height: Math.max(1, node.height - TEXT_PADDING * 2),
    text: node.text,
    fontFamily: TEXT_FONT_FAMILY,
    fontSize: TEXT_FONT_SIZE,
    lineHeight: TEXT_LINE_HEIGHT,
    fill: "#111827",
    wrap: "char",
    listening: false,
    name: NODE_TEXT_NAME,
  });

  group.add(rect, textHit, ...moveHits, text);

  return {
    group,
    textHit,
    moveHits,
  };
}

export function applyGroupSize(group: Konva.Group, width: number, height: number): void {
  group.width(width);
  group.height(height);

  const rect = group.findOne(`.${NODE_RECT_NAME}`);
  const text = group.findOne(`.${NODE_TEXT_NAME}`);
  const textHit = group.findOne(`.${NODE_TEXT_HIT_NAME}`);

  if (rect instanceof Konva.Rect) {
    rect.width(width);
    rect.height(height);
  }

  if (text instanceof Konva.Text) {
    text.width(Math.max(1, width - TEXT_PADDING * 2));
    text.height(Math.max(1, height - TEXT_PADDING * 2));
  }

  if (textHit instanceof Konva.Rect) {
    textHit.position({
      x: TEXT_PADDING,
      y: TEXT_PADDING,
    });
    textHit.width(Math.max(1, width - TEXT_PADDING * 2));
    textHit.height(Math.max(1, height - TEXT_PADDING * 2));
  }

  group.find(`.${NODE_MOVE_HIT_NAME}`).forEach((hit) => {
    if (hit instanceof Konva.Rect) {
      applyMoveHitRectFrame(hit, width, height);
    }
  });
}

export function applyNodeSelectionStyle(group: Konva.Group, selected: boolean): void {
  const rect = group.findOne(`.${NODE_RECT_NAME}`);

  if (!(rect instanceof Konva.Rect)) {
    return;
  }

  rect.stroke(selected ? SELECTED_STROKE : NODE_STROKE);
  rect.strokeWidth(selected ? SELECTED_STROKE_WIDTH : UNSELECTED_STROKE_WIDTH);
  rect.shadowColor(selected ? SELECTED_SHADOW : "transparent");
  rect.shadowBlur(selected ? SELECTED_SHADOW_BLUR : 0);
}

export function findNamedNode(target: Konva.Node, name: string): Konva.Node | null {
  let current: Konva.Node | null = target;

  while (current) {
    if (current.hasName(name)) {
      return current;
    }

    current = current.getParent();
  }

  return null;
}

export function getClientPointFromEvent(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if (event instanceof MouseEvent) {
    return {
      x: event.clientX,
      y: event.clientY,
    };
  }

  const touch = event.touches[0] ?? event.changedTouches[0];

  return touch
    ? {
        x: touch.clientX,
        y: touch.clientY,
      }
    : null;
}

export function isConnectorSide(value: unknown): value is ConnectorSide {
  return value === "top" || value === "right" || value === "bottom" || value === "left";
}

function createMoveHitRects(width: number, height: number): Konva.Rect[] {
  return MOVE_HIT_PARTS.map((part) => {
    const rect = new Konva.Rect({
      fill: "rgba(255, 255, 255, 0.01)",
      name: NODE_MOVE_HIT_NAME,
    });
    rect.setAttr("hitPart", part);
    applyMoveHitRectFrame(rect, width, height);

    return rect;
  });
}

function applyMoveHitRectFrame(rect: Konva.Rect, width: number, height: number): void {
  const part = rect.getAttr("hitPart");

  if (!isMoveHitPart(part)) {
    return;
  }

  switch (part) {
    case "top":
      rect.position({
        x: 0,
        y: 0,
      });
      rect.width(width);
      rect.height(MOVE_HIT_SIZE);
      break;
    case "right":
      rect.position({
        x: Math.max(0, width - MOVE_HIT_SIZE),
        y: 0,
      });
      rect.width(MOVE_HIT_SIZE);
      rect.height(height);
      break;
    case "bottom":
      rect.position({
        x: 0,
        y: Math.max(0, height - MOVE_HIT_SIZE),
      });
      rect.width(width);
      rect.height(MOVE_HIT_SIZE);
      break;
    case "left":
      rect.position({
        x: 0,
        y: 0,
      });
      rect.width(MOVE_HIT_SIZE);
      rect.height(height);
      break;
  }
}

function isMoveHitPart(value: unknown): value is MoveHitPart {
  return MOVE_HIT_PARTS.some((part) => part === value);
}
