import Konva from "konva";
import { GRID_SIZE, MAX_SCALE, MIN_SCALE, ZOOM_STEP } from "./canvasConstants";
import type { NodeFrame } from "./types";

export function resetStageView(stage: Konva.Stage, host: HTMLDivElement, nodes: NodeFrame[]): void {
  if (nodes.length === 0) {
    stage.scale({
      x: 1,
      y: 1,
    });
    stage.position({
      x: 0,
      y: 0,
    });
    updateGrid(host, stage);
    stage.batchDraw();
    return;
  }

  const bounds = nodes.reduce(
    (next, node) => ({
      minX: Math.min(next.minX, node.x),
      minY: Math.min(next.minY, node.y),
      maxX: Math.max(next.maxX, node.x + node.width),
      maxY: Math.max(next.maxY, node.y + node.height),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const padding = 120;
  const scale = Math.min(
    1,
    stage.width() / (contentWidth + padding * 2),
    stage.height() / (contentHeight + padding * 2),
  );
  const centerX = bounds.minX + contentWidth / 2;
  const centerY = bounds.minY + contentHeight / 2;

  stage.scale({
    x: scale,
    y: scale,
  });
  stage.position({
    x: stage.width() / 2 - centerX * scale,
    y: stage.height() / 2 - centerY * scale,
  });
  updateGrid(host, stage);
  stage.batchDraw();
}

export function zoomStageWithWheel(stage: Konva.Stage, host: HTMLDivElement, event: WheelEvent): void {
  event.preventDefault();

  const oldScale = stage.scaleX();
  const rect = stage.container().getBoundingClientRect();
  const pointer = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
  const worldPoint = {
    x: (pointer.x - stage.x()) / oldScale,
    y: (pointer.y - stage.y()) / oldScale,
  };
  const nextScale = clampScale(event.deltaY < 0 ? oldScale * ZOOM_STEP : oldScale / ZOOM_STEP);

  stage.scale({
    x: nextScale,
    y: nextScale,
  });
  stage.position({
    x: pointer.x - worldPoint.x * nextScale,
    y: pointer.y - worldPoint.y * nextScale,
  });
  updateGrid(host, stage);
  stage.batchDraw();
}

export function getWorldPointerPosition(stage: Konva.Stage): { x: number; y: number } | null {
  const pointer = stage.getPointerPosition();

  return pointer ? screenToWorld(stage, pointer) : null;
}

export function screenToWorld(stage: Konva.Stage, point: { x: number; y: number }): { x: number; y: number } {
  const scale = stage.scaleX();

  return {
    x: (point.x - stage.x()) / scale,
    y: (point.y - stage.y()) / scale,
  };
}

export function updateGrid(host: HTMLDivElement, stage: Konva.Stage): void {
  const scale = stage.scaleX();
  const size = GRID_SIZE * scale;

  host.style.backgroundSize = `${size}px ${size}px`;
  host.style.backgroundPosition = `${mod(stage.x(), size)}px ${mod(stage.y(), size)}px`;
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
