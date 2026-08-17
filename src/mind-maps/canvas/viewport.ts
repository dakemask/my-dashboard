import { boundsOfFrames, type Point, type Rect } from "./geometry";
import type { NodeFrame } from "../domain";

export const MIN_VIEWPORT_SCALE = 0.25;
export const MAX_VIEWPORT_SCALE = 2.5;

export interface ClientRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasViewport {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface FitViewportOptions {
  readonly canvasRect: ClientRectLike;
  readonly sidebarRect?: ClientRectLike | null;
  readonly padding?: number;
  readonly minimumScale?: number;
  readonly maximumScale?: number;
}

export const IDENTITY_VIEWPORT: CanvasViewport = Object.freeze({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
});

export function clampScale(
  scale: number,
  minimum = MIN_VIEWPORT_SCALE,
  maximum = MAX_VIEWPORT_SCALE,
): number {
  if (!Number.isFinite(scale)) return Math.min(maximum, Math.max(minimum, 1));
  return Math.min(maximum, Math.max(minimum, scale));
}

export function normalizeViewport(viewport: CanvasViewport): CanvasViewport {
  return {
    scale: clampScale(viewport.scale),
    offsetX: Number.isFinite(viewport.offsetX) ? viewport.offsetX : 0,
    offsetY: Number.isFinite(viewport.offsetY) ? viewport.offsetY : 0,
  };
}

export function clientToWorld(
  client: Point,
  canvasRect: ClientRectLike,
  viewport: CanvasViewport,
): Point {
  return {
    x: (client.x - canvasRect.left - viewport.offsetX) / viewport.scale,
    y: (client.y - canvasRect.top - viewport.offsetY) / viewport.scale,
  };
}

export function worldToClient(
  world: Point,
  canvasRect: ClientRectLike,
  viewport: CanvasViewport,
): Point {
  return {
    x: canvasRect.left + viewport.offsetX + world.x * viewport.scale,
    y: canvasRect.top + viewport.offsetY + world.y * viewport.scale,
  };
}

export function zoomAtClientPoint(
  viewport: CanvasViewport,
  canvasRect: ClientRectLike,
  client: Point,
  requestedScale: number,
): CanvasViewport {
  const anchor = clientToWorld(client, canvasRect, viewport);
  const scale = clampScale(requestedScale);
  return {
    scale,
    offsetX: client.x - canvasRect.left - anchor.x * scale,
    offsetY: client.y - canvasRect.top - anchor.y * scale,
  };
}

export function wheelZoomScale(currentScale: number, deltaY: number): number {
  return clampScale(currentScale * Math.exp(-deltaY * 0.001));
}

export function panViewport(viewport: CanvasViewport, delta: Point): CanvasViewport {
  return {
    ...viewport,
    offsetX: viewport.offsetX + delta.x,
    offsetY: viewport.offsetY + delta.y,
  };
}

export function visibleCanvasRect(
  canvasRect: ClientRectLike,
  sidebarRect?: ClientRectLike | null,
): ClientRectLike {
  if (!sidebarRect || !rectanglesOverlap(canvasRect, sidebarRect)) return { ...canvasRect };

  const sidebarRight = sidebarRect.left + sidebarRect.width;
  const canvasMidpoint = canvasRect.left + canvasRect.width / 2;
  if (sidebarRect.left >= canvasMidpoint || sidebarRight <= canvasRect.left) return { ...canvasRect };

  const left = Math.min(canvasRect.left + canvasRect.width, Math.max(canvasRect.left, sidebarRight));
  return {
    left,
    top: canvasRect.top,
    width: Math.max(0, canvasRect.left + canvasRect.width - left),
    height: canvasRect.height,
  };
}

export function fitFramesInViewport(
  frames: readonly NodeFrame[],
  options: FitViewportOptions,
): CanvasViewport {
  const bounds = boundsOfFrames(frames);
  if (!bounds) return { ...IDENTITY_VIEWPORT };
  return fitRectInViewport(bounds, options);
}

export function fitRectInViewport(bounds: Rect, options: FitViewportOptions): CanvasViewport {
  const canvas = options.canvasRect;
  const visible = visibleCanvasRect(canvas, options.sidebarRect);
  const padding = Math.max(0, options.padding ?? 48);
  const usableWidth = Math.max(1, visible.width - padding * 2);
  const usableHeight = Math.max(1, visible.height - padding * 2);
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const scale = clampScale(
    Math.min(usableWidth / width, usableHeight / height),
    options.minimumScale ?? MIN_VIEWPORT_SCALE,
    options.maximumScale ?? MAX_VIEWPORT_SCALE,
  );
  const targetCenterX = visible.left - canvas.left + visible.width / 2;
  const targetCenterY = visible.top - canvas.top + visible.height / 2;

  return {
    scale,
    offsetX: targetCenterX - (bounds.x + bounds.width / 2) * scale,
    offsetY: targetCenterY - (bounds.y + bounds.height / 2) * scale,
  };
}

function rectanglesOverlap(left: ClientRectLike, right: ClientRectLike): boolean {
  return (
    left.left < right.left + right.width &&
    left.left + left.width > right.left &&
    left.top < right.top + right.height &&
    left.top + left.height > right.top
  );
}
