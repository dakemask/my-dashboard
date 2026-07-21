import { describe, expect, it, vi } from "vitest";
import type { MindMapArrow, MindMapNode, NodeFrame } from "../../src/mind-map/domain";
import {
  EdgeAutoPan,
  arrowLine,
  boundsOfFrames,
  clientToWorld,
  connectorMidpoint,
  edgePanVelocity,
  fitRectInViewport,
  normalizeRect,
  rectFullyContainsLine,
  rectFullyContainsRect,
  visibleCanvasRect,
  wheelZoomScale,
  worldToClient,
  zoomAtClientPoint,
  type AnimationFrameScheduler,
} from "../../src/mind-map/canvas";

const frame = (x: number, y: number, width: number, height: number): NodeFrame => ({
  x,
  y,
  width,
  height,
});

describe("mind-map canvas geometry", () => {
  it("normalizes rectangles and requires complete containment", () => {
    const container = normalizeRect({ x: 100, y: 80 }, { x: 0, y: 0 });
    expect(container).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(rectFullyContainsRect(container, { x: 0, y: 10, width: 100, height: 70 })).toBe(true);
    expect(rectFullyContainsRect(container, { x: -0.01, y: 10, width: 50, height: 20 })).toBe(false);
    expect(rectFullyContainsLine(container, {
      from: { x: 0, y: 0 },
      to: { x: 100, y: 80 },
    })).toBe(true);
    expect(rectFullyContainsLine(container, {
      from: { x: 10, y: 10 },
      to: { x: 101, y: 20 },
    })).toBe(false);
  });

  it("computes connector midpoints and straight arrow endpoints", () => {
    const first: MindMapNode = {
      id: "one",
      text: "",
      autoWidth: false,
      ...frame(10, 20, 100, 60),
    };
    const second: MindMapNode = {
      id: "two",
      text: "",
      autoWidth: false,
      ...frame(200, 100, 80, 40),
    };
    expect(connectorMidpoint(first, "top")).toEqual({ x: 60, y: 20 });
    expect(connectorMidpoint(first, "right")).toEqual({ x: 110, y: 50 });
    expect(connectorMidpoint(first, "bottom")).toEqual({ x: 60, y: 80 });
    expect(connectorMidpoint(first, "left")).toEqual({ x: 10, y: 50 });

    const arrow: MindMapArrow = {
      id: "arrow",
      from: { nodeId: "one", side: "right" },
      to: { nodeId: "two", side: "left" },
    };
    expect(arrowLine(arrow, new Map([[first.id, first], [second.id, second]]))).toEqual({
      from: { x: 110, y: 50 },
      to: { x: 200, y: 120 },
    });
    expect(arrowLine({ ...arrow, to: { nodeId: "missing", side: "left" } }, new Map([[first.id, first]])))
      .toBeNull();
  });

  it("finds bounds without imposing a world origin", () => {
    expect(boundsOfFrames([frame(-20, 30, 10, 20), frame(40, -10, 30, 50)])).toEqual({
      x: -20,
      y: -10,
      width: 90,
      height: 60,
    });
    expect(boundsOfFrames([])).toBeNull();
  });
});

describe("mind-map viewport", () => {
  const canvasRect = { left: 100, top: 50, width: 800, height: 600 };

  it("round-trips client and world coordinates", () => {
    const viewport = { scale: 2, offsetX: 30, offsetY: -10 };
    const client = worldToClient({ x: 45, y: 70 }, canvasRect, viewport);
    expect(client).toEqual({ x: 220, y: 180 });
    expect(clientToWorld(client, canvasRect, viewport)).toEqual({ x: 45, y: 70 });
  });

  it("keeps the cursor world point fixed while zooming and clamps scale", () => {
    const original = { scale: 1, offsetX: 20, offsetY: 30 };
    const cursor = { x: 420, y: 260 };
    const world = clientToWorld(cursor, canvasRect, original);
    const zoomed = zoomAtClientPoint(original, canvasRect, cursor, 2);
    expect(zoomed.scale).toBe(2);
    expect(worldToClient(world, canvasRect, zoomed)).toEqual(cursor);
    expect(zoomAtClientPoint(original, canvasRect, cursor, 99).scale).toBe(2.5);
    expect(zoomAtClientPoint(original, canvasRect, cursor, 0.001).scale).toBe(0.25);
    expect(zoomAtClientPoint(original, canvasRect, cursor, Number.NaN).scale).toBe(1);
    expect(wheelZoomScale(2.5, -1000)).toBe(2.5);
    expect(wheelZoomScale(0.25, 1000)).toBe(0.25);
  });

  it("fits into the area to the right of a floating left sidebar", () => {
    const canvas = { left: 0, top: 0, width: 1000, height: 600 };
    const sidebar = { left: 18, top: 20, width: 250, height: 560 };
    expect(visibleCanvasRect(canvas, sidebar)).toEqual({ left: 268, top: 0, width: 732, height: 600 });
    const viewport = fitRectInViewport({ x: 0, y: 0, width: 100, height: 100 }, {
      canvasRect: canvas,
      sidebarRect: sidebar,
      padding: 50,
    });
    expect(viewport.scale).toBe(2.5);
    expect(worldToClient({ x: 50, y: 50 }, canvas, viewport)).toEqual({ x: 634, y: 300 });
  });
});

describe("edge auto-pan", () => {
  const bounds = { left: 10, top: 20, width: 400, height: 300 };

  it("returns viewport velocity in all four edge zones", () => {
    expect(edgePanVelocity({ x: 10, y: 170 }, bounds, { edgeSize: 50, maximumSpeed: 500 }))
      .toEqual({ x: 500, y: 0 });
    expect(edgePanVelocity({ x: 410, y: 170 }, bounds, { edgeSize: 50, maximumSpeed: 500 }))
      .toEqual({ x: -500, y: 0 });
    expect(edgePanVelocity({ x: 210, y: 20 }, bounds, { edgeSize: 50, maximumSpeed: 500 }))
      .toEqual({ x: 0, y: 500 });
    expect(edgePanVelocity({ x: 210, y: 320 }, bounds, { edgeSize: 50, maximumSpeed: 500 }))
      .toEqual({ x: 0, y: -500 });
    expect(edgePanVelocity({ x: 210, y: 170 }, bounds, { edgeSize: 50, maximumSpeed: 500 }))
      .toEqual({ x: 0, y: 0 });
  });

  it("uses an injectable animation scheduler and stops cleanly", () => {
    const scheduler = new ManualScheduler();
    const onPan = vi.fn();
    const autoPan = new EdgeAutoPan({
      getPointer: () => ({ x: 410, y: 170 }),
      getBounds: () => bounds,
      onPan,
      scheduler,
      edgeSize: 50,
      maximumSpeed: 600,
    });
    autoPan.start();
    expect(autoPan.running).toBe(true);
    scheduler.run(100);
    expect(onPan).toHaveBeenLastCalledWith({ x: -10, y: 0 });
    scheduler.run(150);
    expect(onPan).toHaveBeenLastCalledWith({ x: -30, y: 0 });
    autoPan.stop();
    expect(autoPan.running).toBe(false);
    expect(scheduler.size).toBe(0);
  });
});

class ManualScheduler implements AnimationFrameScheduler {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextId = 1;

  get size(): number {
    return this.#callbacks.size;
  }

  request(callback: FrameRequestCallback): number {
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return id;
  }

  cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  run(timestamp: number): void {
    const next = this.#callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!next) throw new Error("No scheduled frame.");
    this.#callbacks.delete(next[0]);
    next[1](timestamp);
  }
}
