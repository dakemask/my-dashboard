// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MindMapDocument } from "../../src/mind-map/domain";
import {
  MindMapCanvas,
  type AnimationFrameScheduler,
  type CanvasTextMeasurement,
  type MindMapCanvasCallbacks,
} from "../../src/mind-map/canvas";

const map: MindMapDocument = {
  id: "map-one",
  path: "First",
  nodes: [
    { id: "n1", text: "A", x: 20, y: 20, width: 80, height: 40, autoWidth: false },
    { id: "n2", text: "B", x: 140, y: 20, width: 80, height: 40, autoWidth: false },
  ],
  arrows: [
    {
      id: "a1",
      from: { nodeId: "n1", side: "right" },
      to: { nodeId: "n2", side: "left" },
    },
  ],
};

const textMeasurement: CanvasTextMeasurement = {
  measure: ({ text, width }) => ({
    naturalWidth: text.length > 0 ? 120 : 32,
    height: width < 100 ? 70 : 50,
    minimumWidth: 32,
    minimumHeight: 35,
  }),
};

const canvases: MindMapCanvas[] = [];

afterEach(() => {
  for (const canvas of canvases.splice(0)) canvas.destroy();
  document.body.replaceChildren();
});

describe("MindMapCanvas", () => {
  it("projects states, exposes only one resize handle, and temporarily raises selected nodes", () => {
    const { canvas, host } = createCanvas();
    canvas.project(map);
    canvas.setViewport({ scale: 1, offsetX: 0, offsetY: 0 });

    canvas.setSelection({ nodeIds: ["n1"], arrowIds: [] });
    expect(host.querySelector('[data-node-id="n1"]')?.classList).toContain("is-moving");
    expect(host.querySelectorAll(".mind-map-canvas__resize-handle")).toHaveLength(1);
    expect([...host.querySelectorAll<SVGGElement>(".mind-map-canvas__node")].at(-1)?.dataset.nodeId)
      .toBe("n1");
    canvas.render({ ...map, nodes: map.nodes.map((node) => node.id === "n1" ? { ...node, text: "updated" } : node) });
    expect(canvas.getSelection().nodeIds).toEqual(["n1"]);

    canvas.setSelection({ nodeIds: ["n1", "n2"], arrowIds: [] });
    expect(host.querySelectorAll(".mind-map-canvas__resize-handle")).toHaveLength(0);

    canvas.editNode("n1");
    expect(host.querySelector('[data-node-id="n1"]')?.classList).toContain("is-editing");
    expect(host.querySelectorAll(".mind-map-canvas__resize-handle")).toHaveLength(1);
  });

  it("fully box-selects nodes and arrows and Ctrl-adds a node before moving the group", () => {
    const onMoveNodes = vi.fn();
    const { canvas, host, scheduler } = createCanvas({ onMoveNodes });
    canvas.project(map);
    canvas.setViewport({ scale: 1, offsetX: 0, offsetY: 0 });

    const grid = required(host, ".mind-map-canvas__grid");
    firePointer(grid, "pointerdown", { clientX: 0, clientY: 0 });
    expect(scheduler.size).toBe(1);
    firePointer(canvas.element, "pointermove", { clientX: 230, clientY: 100 });
    firePointer(canvas.element, "pointerup", { clientX: 230, clientY: 100 });
    expect(canvas.getSelection()).toEqual({ nodeIds: ["n1", "n2"], arrowIds: ["a1"] });
    expect(scheduler.size).toBe(0);

    canvas.setSelection({ nodeIds: ["n1"], arrowIds: [] });
    const n2MoveHit = required(host, '[data-node-id="n2"] .mind-map-canvas__node-move-hit');
    firePointer(n2MoveHit, "pointerdown", { clientX: 140, clientY: 20, ctrlKey: true });
    expect(scheduler.size).toBe(1);
    firePointer(canvas.element, "pointermove", { clientX: 150, clientY: 35 });
    firePointer(canvas.element, "pointerup", { clientX: 150, clientY: 35 });
    expect(onMoveNodes).toHaveBeenCalledWith({ nodeIds: ["n1", "n2"], dx: 10, dy: 15 });
    expect(canvas.getSelection().nodeIds).toEqual(["n1", "n2"]);
  });

  it("reports one fitted text change, detects a pending draft without settling it, and leaves Delete native", async () => {
    const onChangeNodeText = vi.fn();
    const onDeleteSelection = vi.fn();
    const { canvas, host } = createCanvas({ onChangeNodeText, onDeleteSelection });
    canvas.project({
      ...map,
      nodes: [{ id: "n1", text: "", x: 20, y: 20, width: 260, height: 92, autoWidth: false }],
      arrows: [],
    });
    canvas.setViewport({ scale: 1, offsetX: 0, offsetY: 0 });

    required<HTMLTextAreaElement>(host, 'textarea[data-node-id="n1"]').click();
    await Promise.resolve();
    const editor = required<HTMLTextAreaElement>(host, 'textarea[data-node-id="n1"]');
    editor.value = "hello";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(canvas.hasPendingTextChange()).toBe(true);

    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    expect(onDeleteSelection).not.toHaveBeenCalled();
    editor.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    expect(onChangeNodeText).toHaveBeenCalledOnce();
    expect(onChangeNodeText).toHaveBeenCalledWith({
      nodeId: "n1",
      text: "hello",
      frame: { x: 20, y: 20, width: 120, height: 50 },
      autoWidth: false,
    });

    canvas.editNode("n1");
    await Promise.resolve();
    const secondEditor = required<HTMLTextAreaElement>(host, 'textarea[data-node-id="n1"]');
    secondEditor.value = "changed again";
    secondEditor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const settled = canvas.settleLiveInteraction();
    expect(settled?.text).toBe("changed again");
    expect(canvas.hasPendingTextChange()).toBe(false);
    expect(onChangeNodeText).toHaveBeenCalledOnce();
  });

  it("text-tightens a south-east resize and returns autoWidth separately from NodeFrame", () => {
    const onResizeNode = vi.fn();
    const { canvas, host, scheduler } = createCanvas({ onResizeNode });
    canvas.project(map);
    canvas.setViewport({ scale: 1, offsetX: 0, offsetY: 0 });
    canvas.setSelection({ nodeIds: ["n1"], arrowIds: [] });

    const handle = required(host, '.mind-map-canvas__resize-handle[data-node-id="n1"]');
    firePointer(handle, "pointerdown", { clientX: 100, clientY: 60 });
    expect(scheduler.size).toBe(1);
    expect(host.querySelector('[data-node-id="n1"]')?.classList).toContain("is-resizing");
    firePointer(canvas.element, "pointermove", { clientX: 400, clientY: 200 });
    firePointer(canvas.element, "pointerup", { clientX: 400, clientY: 200 });
    expect(onResizeNode).toHaveBeenCalledWith({
      nodeId: "n1",
      frame: { x: 20, y: 20, width: 120, height: 50 },
      autoWidth: true,
    });
  });

  it("runs a single-use connector drag, cancels on invalid blank release, and clears selection", () => {
    const onCreateArrow = vi.fn();
    const { canvas, host, scheduler } = createCanvas({ onCreateArrow });
    canvas.project(map);
    canvas.setViewport({ scale: 1, offsetX: 0, offsetY: 0 });
    canvas.setSelection({ nodeIds: ["n1"], arrowIds: [] });
    canvas.setArrowMode(true);
    expect(canvas.getSelection()).toEqual({ nodeIds: [], arrowIds: [] });

    const source = required(
      host,
      '.mind-map-canvas__connector[data-node-id="n1"][data-side="right"]',
    );
    firePointer(source, "pointerdown", { clientX: 100, clientY: 40 });
    expect(scheduler.size).toBe(1);
    firePointer(canvas.element, "pointermove", { clientX: 140, clientY: 40 });
    expect(host.querySelector(".mind-map-canvas__arrow-preview")).not.toBeNull();
    firePointer(canvas.element, "pointerup", { clientX: 140, clientY: 40 });
    expect(onCreateArrow).toHaveBeenCalledWith({
      from: { nodeId: "n1", side: "right" },
      to: { nodeId: "n2", side: "left" },
    });
    expect(canvas.arrowMode).toBe(false);
    expect(canvas.getSelection()).toEqual({ nodeIds: [], arrowIds: [] });

    canvas.setArrowMode(true);
    const nextSource = required(
      host,
      '.mind-map-canvas__connector[data-node-id="n1"][data-side="right"]',
    );
    firePointer(nextSource, "pointerdown", { clientX: 100, clientY: 40 });
    firePointer(canvas.element, "pointerup", { clientX: 500, clientY: 400 });
    expect(onCreateArrow).toHaveBeenCalledOnce();
    expect(canvas.arrowMode).toBe(false);
  });

  it("right-drags blank space without clearing selection and remembers each map viewport", () => {
    const onDeleteSelection = vi.fn();
    const { canvas, host } = createCanvas({ onDeleteSelection });
    canvas.project(map);
    canvas.setViewport({ scale: 1, offsetX: 10, offsetY: 20 });
    canvas.setSelection({ nodeIds: ["n1"], arrowIds: [] });
    const grid = required(host, ".mind-map-canvas__grid");
    firePointer(grid, "pointerdown", { button: 2, clientX: 300, clientY: 200 });
    firePointer(canvas.element, "pointermove", { button: 2, clientX: 330, clientY: 240 });
    firePointer(canvas.element, "pointerup", { button: 2, clientX: 330, clientY: 240 });
    expect(canvas.getViewport()).toEqual({ scale: 1, offsetX: 40, offsetY: 60 });
    expect(canvas.getSelection().nodeIds).toEqual(["n1"]);

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    canvas.element.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);

    canvas.element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    }));
    expect(onDeleteSelection).not.toHaveBeenCalled();
    canvas.element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Delete",
      bubbles: true,
      cancelable: true,
    }));
    expect(onDeleteSelection).toHaveBeenCalledOnce();

    const secondMap = { ...map, id: "map-two", path: "Second" };
    canvas.project(secondMap);
    canvas.setViewport({ scale: 0.75, offsetX: -10, offsetY: -20 });
    canvas.project(map);
    expect(canvas.getViewport()).toEqual({ scale: 1, offsetX: 40, offsetY: 60 });
    expect(canvas.getSelection()).toEqual({ nodeIds: [], arrowIds: [] });
  });
});

function createCanvas(callbacks: MindMapCanvasCallbacks = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const scheduler = new ManualScheduler();
  const canvas = new MindMapCanvas(host, {
    callbacks,
    measurements: {
      getCanvasRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      getSidebarRect: () => null,
    },
    pointerCapture: { capture: vi.fn(), release: vi.fn() },
    animationFrames: scheduler,
    textMeasurement,
  });
  canvases.push(canvas);
  return { canvas, host, scheduler };
}

function required<T extends Element = Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing test element: ${selector}`);
  return element;
}

function firePointer(
  target: EventTarget,
  type: string,
  options: MouseEventInit & { readonly pointerId?: number },
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...options });
  Object.defineProperty(event, "pointerId", { value: options.pointerId ?? 1 });
  target.dispatchEvent(event);
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
