// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MindMapDocument, MindMapNode } from "../../src/mind-maps/domain";
import {
  IDENTITY_VIEWPORT,
  MindMapCanvas,
  type AnimationFrameScheduler,
  type CanvasTextMeasurement,
  type PointerCaptureAdapter,
} from "../../src/mind-maps/canvas";

afterEach(() => {
  document.body.replaceChildren();
});

describe("MindMapCanvas keyed rendering", () => {
  it("preserves keyed node, arrow, and textarea elements across data renders", () => {
    const fixture = createFixture();
    const firstNode = nodeGroup(fixture.canvas, "a");
    const secondNode = nodeGroup(fixture.canvas, "b");
    const firstTextarea = textarea(firstNode);
    const arrow = arrowGroup(fixture.canvas, "arrow");

    fixture.canvas.render({
      ...MAP,
      nodes: [MAP.nodes[1]!, { ...MAP.nodes[0]!, x: 140, text: "Alpha updated" }],
    });

    expect(nodeGroup(fixture.canvas, "a")).toBe(firstNode);
    expect(nodeGroup(fixture.canvas, "b")).toBe(secondNode);
    expect(textarea(firstNode)).toBe(firstTextarea);
    expect(firstTextarea.value).toBe("Alpha updated");
    expect(arrowGroup(fixture.canvas, "arrow")).toBe(arrow);
    expect(firstNode.getAttribute("transform")).toBe("translate(140 100)");
    expect([...fixture.canvas.element.querySelectorAll<SVGGElement>(".mind-maps-canvas__node")]
      .map((element) => element.dataset.nodeId)).toEqual(["b", "a"]);
  });

  it("keeps the active textarea and native draft stable while rendering committed data", async () => {
    const fixture = createFixture();
    const original = textarea(nodeGroup(fixture.canvas, "a"));
    fixture.canvas.editNode("a");
    await Promise.resolve();
    original.value = "输入法中的草稿";
    original.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    original.dispatchEvent(new InputEvent("input", { bubbles: true }));

    fixture.canvas.render({
      ...MAP,
      nodes: MAP.nodes.map((node) => node.id === "a" ? { ...node, text: "committed" } : node),
    });

    expect(textarea(nodeGroup(fixture.canvas, "a"))).toBe(original);
    expect(original.value).toBe("输入法中的草稿");
    expect(fixture.canvas.hasPendingTextChange()).toBe(true);
  });

  it("updates only affected keyed geometry during a move and releases capture/auto-pan", () => {
    const fixture = createFixture();
    const movedNode = nodeGroup(fixture.canvas, "a");
    const untouchedNode = nodeGroup(fixture.canvas, "b");
    const movedTextarea = textarea(movedNode);
    const untouchedTextarea = textarea(untouchedNode);
    const arrow = arrowGroup(fixture.canvas, "arrow");
    const untouchedTransform = untouchedNode.getAttribute("transform");
    const moveHit = movedNode.querySelector<SVGRectElement>(".mind-maps-canvas__node-move-hit")!;

    dispatchPointer(moveHit, "pointerdown", { pointerId: 7, clientX: 150, clientY: 130 });
    dispatchPointer(fixture.canvas.element, "pointermove", {
      pointerId: 7,
      clientX: 200,
      clientY: 180,
    });

    expect(nodeGroup(fixture.canvas, "a")).toBe(movedNode);
    expect(nodeGroup(fixture.canvas, "b")).toBe(untouchedNode);
    expect(textarea(movedNode)).toBe(movedTextarea);
    expect(textarea(untouchedNode)).toBe(untouchedTextarea);
    expect(arrowGroup(fixture.canvas, "arrow")).toBe(arrow);
    expect(movedNode.getAttribute("transform")).toBe("translate(150 150)");
    expect(untouchedNode.getAttribute("transform")).toBe(untouchedTransform);
    expect(fixture.scheduler.size).toBe(1);

    dispatchPointer(fixture.canvas.element, "pointerup", {
      pointerId: 7,
      clientX: 200,
      clientY: 180,
    });

    expect(fixture.callbacks.onMoveNodes).toHaveBeenCalledWith({
      nodeIds: ["a"],
      dx: 50,
      dy: 50,
    });
    expect(fixture.capture.release).toHaveBeenCalledWith(fixture.canvas.element, 7);
    expect(fixture.scheduler.size).toBe(0);
  });

  it("raises marquee-selected keyed groups without replacing them", () => {
    const fixture = createFixture();
    const firstNode = nodeGroup(fixture.canvas, "a");
    const firstTextarea = textarea(firstNode);

    dispatchPointer(fixture.canvas.element, "pointerdown", {
      pointerId: 8,
      clientX: 90,
      clientY: 90,
    });
    dispatchPointer(fixture.canvas.element, "pointermove", {
      pointerId: 8,
      clientX: 210,
      clientY: 170,
    });

    expect(fixture.canvas.getSelection()).toEqual({ nodeIds: ["a"], arrowIds: [] });
    expect(nodeGroup(fixture.canvas, "a")).toBe(firstNode);
    expect(textarea(firstNode)).toBe(firstTextarea);
    expect([...fixture.canvas.element.querySelectorAll<SVGGElement>(".mind-maps-canvas__node")]
      .map((element) => element.dataset.nodeId)).toEqual(["b", "a"]);

    dispatchPointer(fixture.canvas.element, "pointerup", {
      pointerId: 8,
      clientX: 210,
      clientY: 170,
    });
  });

  it("keeps a selected group intact for Ctrl+drag and moves the whole group", () => {
    const fixture = createFixture();
    fixture.canvas.setSelection({ nodeIds: ["a", "b"], arrowIds: [] });
    const moveHit = nodeGroup(fixture.canvas, "a")
      .querySelector<SVGRectElement>(".mind-maps-canvas__node-move-hit")!;

    dispatchPointer(moveHit, "pointerdown", {
      pointerId: 9,
      clientX: 150,
      clientY: 130,
      ctrlKey: true,
    });
    expect(fixture.canvas.getSelection()).toEqual({ nodeIds: ["a", "b"], arrowIds: [] });

    dispatchPointer(fixture.canvas.element, "pointermove", {
      pointerId: 9,
      clientX: 170,
      clientY: 150,
      ctrlKey: true,
    });
    expect(nodeGroup(fixture.canvas, "a").getAttribute("transform")).toBe("translate(120 120)");
    expect(nodeGroup(fixture.canvas, "b").getAttribute("transform")).toBe("translate(320 120)");

    dispatchPointer(fixture.canvas.element, "pointerup", {
      pointerId: 9,
      clientX: 170,
      clientY: 150,
      ctrlKey: true,
    });
    expect(fixture.callbacks.onMoveNodes).toHaveBeenCalledWith({
      nodeIds: ["a", "b"],
      dx: 20,
      dy: 20,
    });
    expect(fixture.canvas.getSelection()).toEqual({ nodeIds: ["a", "b"], arrowIds: [] });
  });

  it("toggles an already selected node only when Ctrl ends as a click", () => {
    const fixture = createFixture();
    fixture.canvas.setSelection({ nodeIds: ["a", "b"], arrowIds: [] });
    const moveHit = nodeGroup(fixture.canvas, "a")
      .querySelector<SVGRectElement>(".mind-maps-canvas__node-move-hit")!;

    dispatchPointer(moveHit, "pointerdown", {
      pointerId: 10,
      clientX: 150,
      clientY: 130,
      ctrlKey: true,
    });
    expect(fixture.canvas.getSelection()).toEqual({ nodeIds: ["a", "b"], arrowIds: [] });

    dispatchPointer(fixture.canvas.element, "pointerup", {
      pointerId: 10,
      clientX: 152,
      clientY: 131,
      ctrlKey: true,
    });
    expect(fixture.canvas.getSelection()).toEqual({ nodeIds: ["b"], arrowIds: [] });
    expect(fixture.callbacks.onMoveNodes).not.toHaveBeenCalled();
  });

  it("cancels geometry, overlays, and auto-pan when pointer capture is lost", () => {
    const fixture = createFixture();
    const movedNode = nodeGroup(fixture.canvas, "a");
    const moveHit = movedNode.querySelector<SVGRectElement>(".mind-maps-canvas__node-move-hit")!;
    dispatchPointer(moveHit, "pointerdown", {
      pointerId: 11,
      clientX: 150,
      clientY: 130,
    });
    dispatchPointer(fixture.canvas.element, "pointermove", {
      pointerId: 11,
      clientX: 180,
      clientY: 160,
    });
    expect(movedNode.getAttribute("transform")).toBe("translate(130 130)");
    expect(fixture.scheduler.size).toBe(1);

    dispatchPointer(fixture.canvas.element, "lostpointercapture", {
      pointerId: 11,
      clientX: 180,
      clientY: 160,
    });
    expect(movedNode.getAttribute("transform")).toBe("translate(100 100)");
    expect(fixture.canvas.element.classList.contains("is-moving")).toBe(false);
    expect(fixture.scheduler.size).toBe(0);
    expect(fixture.callbacks.onMoveNodes).not.toHaveBeenCalled();

    dispatchPointer(fixture.canvas.element, "pointerdown", {
      pointerId: 12,
      clientX: 90,
      clientY: 90,
    });
    dispatchPointer(fixture.canvas.element, "pointermove", {
      pointerId: 12,
      clientX: 210,
      clientY: 170,
    });
    expect(fixture.canvas.element.querySelector(".mind-maps-canvas__marquee")).not.toBeNull();
    dispatchPointer(fixture.canvas.element, "lostpointercapture", {
      pointerId: 12,
      clientX: 210,
      clientY: 170,
    });
    expect(fixture.canvas.element.querySelector(".mind-maps-canvas__marquee")).toBeNull();
    expect(fixture.scheduler.size).toBe(0);
  });

  it("does not let synchronous lostpointercapture cancel a normal completed release", () => {
    const capture = vi.fn();
    const release = vi.fn((svg: SVGSVGElement, pointerId: number) => {
      dispatchPointer(svg, "lostpointercapture", { pointerId, clientX: 180, clientY: 160 });
    });
    const fixture = createFixture({ pointerCapture: { capture, release } });
    const moveHit = nodeGroup(fixture.canvas, "a")
      .querySelector<SVGRectElement>(".mind-maps-canvas__node-move-hit")!;
    dispatchPointer(moveHit, "pointerdown", {
      pointerId: 13,
      clientX: 150,
      clientY: 130,
    });
    dispatchPointer(fixture.canvas.element, "pointerup", {
      pointerId: 13,
      clientX: 180,
      clientY: 160,
    });

    expect(release).toHaveBeenCalledWith(fixture.canvas.element, 13);
    expect(fixture.callbacks.onMoveNodes).toHaveBeenCalledWith({
      nodeIds: ["a"],
      dx: 30,
      dy: 30,
    });
  });

  it("does not own the page Delete command and reports arrow mode through one callback", () => {
    const fixture = createFixture();
    fixture.canvas.setSelection({ nodeIds: ["a"], arrowIds: [] });
    fixture.canvas.element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Delete",
      bubbles: true,
      cancelable: true,
    }));
    expect(fixture.callbacks.onDeleteSelection).not.toHaveBeenCalled();

    fixture.canvas.setArrowMode(true);
    fixture.canvas.setArrowMode(true);
    fixture.canvas.setArrowMode(false);
    expect(fixture.callbacks.onArrowModeChange.mock.calls).toEqual([[true], [false]]);
  });
});

interface Fixture {
  readonly canvas: MindMapCanvas;
  readonly callbacks: {
    readonly onMoveNodes: ReturnType<typeof vi.fn>;
    readonly onDeleteSelection: ReturnType<typeof vi.fn>;
    readonly onArrowModeChange: ReturnType<typeof vi.fn>;
  };
  readonly capture: {
    readonly capture: ReturnType<typeof vi.fn>;
    readonly release: ReturnType<typeof vi.fn>;
  };
  readonly scheduler: ManualScheduler;
}

function createFixture(
  options: { readonly pointerCapture?: PointerCaptureAdapter } = {},
): Fixture {
  const host = document.createElement("div");
  document.body.append(host);
  const scheduler = new ManualScheduler();
  const capture = options.pointerCapture ?? { capture: vi.fn(), release: vi.fn() };
  const callbacks = {
    onMoveNodes: vi.fn(),
    onDeleteSelection: vi.fn(),
    onArrowModeChange: vi.fn(),
  };
  const canvas = new MindMapCanvas(host, {
    callbacks,
    measurements: {
      getCanvasRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    },
    pointerCapture: capture,
    animationFrames: scheduler,
    textMeasurement: FIXED_TEXT_MEASUREMENT,
  });
  canvas.project(MAP, { viewport: IDENTITY_VIEWPORT, fitIfNew: false });
  return {
    canvas,
    callbacks,
    capture: capture as Fixture["capture"],
    scheduler,
  };
}

const FIXED_TEXT_MEASUREMENT: CanvasTextMeasurement = {
  measure({ text, width }) {
    const naturalWidth = Math.max(32, [...text].length * 10 + 18);
    const lines = Math.max(1, Math.ceil(naturalWidth / Math.max(1, width)));
    return {
      naturalWidth,
      wrappedWidth: Math.min(width, naturalWidth),
      characterWidth: 10,
      height: Math.max(35, lines * 20 + 14),
      minimumWidth: 32,
      minimumHeight: 35,
    };
  },
};

const NODES: readonly MindMapNode[] = [
  { id: "a", text: "Alpha", x: 100, y: 100, width: 100, height: 60, autoWidth: false },
  { id: "b", text: "Beta", x: 300, y: 100, width: 100, height: 60, autoWidth: false },
];

const MAP: MindMapDocument = {
  id: "map",
  path: "Map",
  nodes: NODES,
  arrows: [{
    id: "arrow",
    from: { nodeId: "a", side: "right" },
    to: { nodeId: "b", side: "left" },
  }],
};

function nodeGroup(canvas: MindMapCanvas, nodeId: string): SVGGElement {
  return canvas.element.querySelector<SVGGElement>(`g[data-node-id="${nodeId}"]`)!;
}

function arrowGroup(canvas: MindMapCanvas, arrowId: string): SVGGElement {
  return canvas.element.querySelector<SVGGElement>(`g[data-arrow-id="${arrowId}"]`)!;
}

function textarea(group: SVGGElement): HTMLTextAreaElement {
  return group.querySelector<HTMLTextAreaElement>("textarea")!;
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { readonly pointerId: number },
): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  target.dispatchEvent(event);
  return event;
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
}
