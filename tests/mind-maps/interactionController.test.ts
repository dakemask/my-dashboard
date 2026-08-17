// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  CanvasInteractionController,
  type ActivePointerInteraction,
  type AnimationFrameScheduler,
} from "../../src/mind-maps/canvas";

describe("CanvasInteractionController", () => {
  it("owns capture and cleanup for all pointer modes", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const scheduler = new ManualScheduler();
    const capture = vi.fn();
    const release = vi.fn();
    const controller = new CanvasInteractionController({
      svg,
      pointerCapture: { capture, release },
      getBounds: () => ({ left: 0, top: 0, width: 500, height: 400 }),
      onAutoPan: vi.fn(),
      animationFrames: scheduler,
    });

    for (const interaction of interactions()) {
      controller.begin(interaction);
      expect(capture).toHaveBeenLastCalledWith(svg, interaction.pointerId);
      expect(controller.current.kind).toBe(interaction.kind);
      expect(controller.autoPanRunning).toBe(interaction.kind !== "panning");
      expect(controller.finish()).toBe(interaction);
      expect(release).toHaveBeenLastCalledWith(svg, interaction.pointerId);
      expect(controller.current.kind).toBe("idle");
      expect(controller.autoPanRunning).toBe(false);
      expect(scheduler.size).toBe(0);
    }
  });

  it("cancels an active auto-pan frame and ignores a different pointer", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const scheduler = new ManualScheduler();
    const release = vi.fn();
    const onAutoPan = vi.fn();
    const controller = new CanvasInteractionController({
      svg,
      pointerCapture: { capture: vi.fn(), release },
      getBounds: () => ({ left: 0, top: 0, width: 500, height: 400 }),
      onAutoPan,
      animationFrames: scheduler,
    });
    const interaction = interactions()[1]!;
    controller.begin(interaction);

    expect(controller.update(999, { x: 490, y: 200 })).toBeNull();
    expect(controller.update(interaction.pointerId, { x: 490, y: 200 })).toBe(interaction);
    scheduler.run(100);
    expect(onAutoPan).toHaveBeenCalled();
    expect(controller.cancel()).toBe(interaction);
    expect(release).toHaveBeenCalledWith(svg, interaction.pointerId);
    expect(scheduler.size).toBe(0);
  });
});

function interactions(): ActivePointerInteraction[] {
  const base = { lastClient: { x: 10, y: 10 } };
  return [
    {
      ...base,
      kind: "marquee",
      pointerId: 1,
      startWorld: { x: 0, y: 0 },
      currentWorld: { x: 0, y: 0 },
      baseline: { nodeIds: new Set(), arrowIds: new Set() },
      additive: false,
    },
    {
      ...base,
      kind: "moving",
      pointerId: 2,
      startWorld: { x: 0, y: 0 },
      startClient: { x: 10, y: 10 },
      currentWorld: { x: 0, y: 0 },
      nodeIds: ["node"],
      startFrames: new Map(),
      toggleOnClickNodeId: null,
      moved: true,
    },
    {
      ...base,
      kind: "resizing",
      pointerId: 3,
      nodeId: "node",
      startFrame: { x: 0, y: 0, width: 100, height: 60 },
      startClient: { x: 0, y: 0 },
      currentFrame: { x: 0, y: 0, width: 100, height: 60 },
      textPaintHeight: 60,
      moved: true,
    },
    {
      ...base,
      kind: "connecting",
      pointerId: 4,
      from: { nodeId: "node", side: "right" },
      currentWorld: { x: 0, y: 0 },
      target: null,
    },
    {
      ...base,
      kind: "panning",
      pointerId: 5,
      startClient: { x: 0, y: 0 },
      startViewport: { scale: 1, offsetX: 0, offsetY: 0 },
    },
  ];
}

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
