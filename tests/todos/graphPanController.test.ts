// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphPanController,
  type GraphPanFrameScheduler,
} from "../../src/todos/ui/graphPanController";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("GraphPanController", () => {
  it("binds wheel and blank-space mouse panning without stealing task-node input", () => {
    const harness = createHarness();
    harness.graph.scrollLeft = 120;
    const onScrollLeftChange = vi.fn();
    const controller = new GraphPanController({ root: harness.root });
    const unbind = controller.bind(harness.graph, { onScrollLeftChange });

    dispatchPointer(harness.node, "pointerdown", {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 10,
    });
    dispatchPointer(window, "pointermove", {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 40,
      clientY: 10,
    });
    expect(harness.graph.scrollLeft).toBe(120);
    expect(harness.capture.set).not.toHaveBeenCalled();

    const down = dispatchPointer(harness.graph, "pointerdown", {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 100,
      clientY: 10,
    });
    expect(down.defaultPrevented).toBe(true);
    expect(controller.panning).toBe(true);
    expect(harness.graph.classList.contains("is-panning")).toBe(true);
    expect(harness.capture.set).toHaveBeenLastCalledWith(2);

    const move = dispatchPointer(window, "pointermove", {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 40,
      clientY: 10,
    });
    expect(move.defaultPrevented).toBe(true);
    expect(harness.graph.scrollLeft).toBe(180);
    expect(onScrollLeftChange).toHaveBeenLastCalledWith(180);
    dispatchPointer(window, "pointerup", {
      pointerId: 2,
      pointerType: "mouse",
      clientX: 40,
      clientY: 10,
    });
    expect(controller.panning).toBe(false);
    expect(harness.graph.classList.contains("is-panning")).toBe(false);
    expect(harness.capture.release).toHaveBeenLastCalledWith(2);

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 25,
    });
    expect(harness.graph.dispatchEvent(wheel)).toBe(false);
    expect(harness.graph.scrollLeft).toBe(205);
    expect(onScrollLeftChange).toHaveBeenLastCalledWith(205);
    expect(harness.root.querySelector("[style]")).toBeNull();

    unbind();
    dispatchPointer(harness.graph, "pointerdown", {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 100,
      clientY: 10,
    });
    dispatchPointer(window, "pointermove", {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });
    expect(harness.graph.scrollLeft).toBe(205);
    controller.dispose();
  });

  it("gates touch direction, coordinates pending interactions, and suppresses the pan click", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const cancelPendingInteraction = vi.fn();
    let blocked = false;
    const controller = new GraphPanController({ root: harness.root });
    controller.bind(harness.graph, {
      isInteractionBlocked: () => blocked,
      cancelPendingInteraction,
    });
    const click = vi.fn();
    harness.button.addEventListener("click", click);

    dispatchPointer(harness.button, "pointerdown", {
      pointerId: 4,
      pointerType: "touch",
      clientX: 100,
      clientY: 20,
    });
    const horizontal = dispatchPointer(window, "pointermove", {
      pointerId: 4,
      pointerType: "touch",
      clientX: 65,
      clientY: 21,
    });
    expect(horizontal.defaultPrevented).toBe(true);
    expect(cancelPendingInteraction).toHaveBeenCalledTimes(1);
    expect(harness.graph.scrollLeft).toBe(35);
    expect(harness.capture.set).toHaveBeenLastCalledWith(4);
    dispatchPointer(window, "pointerup", {
      pointerId: 4,
      pointerType: "touch",
      clientX: 65,
      clientY: 21,
    });

    const suppressedClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(harness.button.dispatchEvent(suppressedClick)).toBe(false);
    expect(click).not.toHaveBeenCalled();
    harness.button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(1);

    const beforeVertical = harness.graph.scrollLeft;
    dispatchPointer(harness.button, "pointerdown", {
      pointerId: 5,
      pointerType: "touch",
      clientX: 100,
      clientY: 20,
    });
    const vertical = dispatchPointer(window, "pointermove", {
      pointerId: 5,
      pointerType: "touch",
      clientX: 97,
      clientY: 42,
    });
    expect(vertical.defaultPrevented).toBe(false);
    expect(cancelPendingInteraction).toHaveBeenCalledTimes(2);
    expect(harness.graph.scrollLeft).toBe(beforeVertical);
    expect(controller.panning).toBe(false);

    dispatchPointer(harness.button, "pointerdown", {
      pointerId: 6,
      pointerType: "touch",
      clientX: 100,
      clientY: 20,
    });
    blocked = true;
    dispatchPointer(window, "pointermove", {
      pointerId: 6,
      pointerType: "touch",
      clientX: 50,
      clientY: 20,
    });
    expect(cancelPendingInteraction).toHaveBeenCalledTimes(2);
    expect(harness.graph.scrollLeft).toBe(beforeVertical);
    dispatchPointer(window, "pointerup", {
      pointerId: 6,
      pointerType: "touch",
      clientX: 50,
      clientY: 20,
    });
    blocked = false;

    expect(harness.root.querySelector("[style]")).toBeNull();
    controller.dispose();
  });

  it("continues touch momentum and releases capture, frames, and listeners on dispose", () => {
    const harness = createHarness();
    const frames = new ManualFrames();
    const clock = new ManualClock();
    const onScrollLeftChange = vi.fn();
    const controller = new GraphPanController({
      root: harness.root,
      animationFrames: frames,
      now: clock.read,
    });
    controller.bind(harness.graph, { onScrollLeftChange });

    dispatchPointer(harness.graph, "pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      clientX: 100,
      clientY: 10,
    });
    clock.value = 16;
    dispatchPointer(window, "pointermove", {
      pointerId: 7,
      pointerType: "touch",
      clientX: 80,
      clientY: 10,
    });
    clock.value = 32;
    dispatchPointer(window, "pointermove", {
      pointerId: 7,
      pointerType: "touch",
      clientX: 60,
      clientY: 10,
    });
    expect(harness.graph.scrollLeft).toBe(40);
    dispatchPointer(window, "pointerup", {
      pointerId: 7,
      pointerType: "touch",
      clientX: 60,
      clientY: 10,
    });
    expect(harness.capture.release).toHaveBeenCalledWith(7);
    expect(frames.pending).toBe(1);

    frames.flush(48);
    expect(harness.graph.scrollLeft).toBeGreaterThan(40);
    expect(onScrollLeftChange).toHaveBeenLastCalledWith(harness.graph.scrollLeft);
    expect(frames.pending).toBe(1);

    dispatchPointer(harness.node, "pointerdown", {
      pointerId: 8,
      pointerType: "mouse",
      clientX: 100,
      clientY: 10,
    });
    expect(frames.cancel).toHaveBeenCalled();
    expect(controller.panning).toBe(false);
    expect(harness.capture.set).not.toHaveBeenCalledWith(8);

    dispatchPointer(harness.graph, "pointerdown", {
      pointerId: 9,
      pointerType: "mouse",
      clientX: 100,
      clientY: 10,
    });
    expect(harness.capture.set).toHaveBeenLastCalledWith(9);
    const beforeDispose = harness.graph.scrollLeft;
    controller.dispose();
    expect(harness.capture.release).toHaveBeenLastCalledWith(9);
    expect(harness.graph.classList.contains("is-panning")).toBe(false);
    expect(frames.pending).toBe(0);

    dispatchPointer(window, "pointermove", {
      pointerId: 9,
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });
    expect(harness.graph.scrollLeft).toBe(beforeDispose);
    expect(() => controller.bind(harness.graph)).toThrow("disposed");
    expect(harness.root.querySelector("[style]")).toBeNull();
  });
});

interface PointerInit {
  readonly pointerId: number;
  readonly pointerType: "mouse" | "touch";
  readonly clientX: number;
  readonly clientY: number;
}

function dispatchPointer(target: EventTarget, type: string, init: PointerInit): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
  }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: init.pointerId },
    pointerType: { configurable: true, value: init.pointerType },
    isPrimary: { configurable: true, value: true },
  });
  target.dispatchEvent(event);
  return event;
}

function createHarness(): {
  readonly root: HTMLElement;
  readonly graph: HTMLElement;
  readonly node: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly capture: {
    readonly set: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
    readonly release: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
  };
} {
  const root = document.createElement("main");
  const graph = document.createElement("section");
  graph.className = "todo-graph";
  const node = document.createElement("article");
  node.className = "todo-task-node";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "任务";
  node.append(button);
  graph.append(node);
  root.append(graph);
  document.body.append(root);
  Object.defineProperties(graph, {
    clientWidth: { configurable: true, value: 240 },
    scrollWidth: { configurable: true, value: 960 },
  });
  const captured = new Set<number>();
  const set = vi.fn((pointerId: number) => { captured.add(pointerId); });
  const release = vi.fn((pointerId: number) => { captured.delete(pointerId); });
  Object.defineProperties(graph, {
    setPointerCapture: { configurable: true, value: set },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.has(pointerId),
    },
    releasePointerCapture: { configurable: true, value: release },
  });
  return { root, graph, node, button, capture: { set, release } };
}

class ManualClock {
  value = 0;
  readonly read = (): number => this.value;
}

class ManualFrames implements GraphPanFrameScheduler {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextHandle = 1;
  readonly cancel = vi.fn((handle: number): void => {
    this.#callbacks.delete(handle);
  });

  get pending(): number {
    return this.#callbacks.size;
  }

  request(callback: FrameRequestCallback): number {
    const handle = this.#nextHandle++;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  flush(time: number): void {
    const callbacks = [...this.#callbacks.entries()];
    this.#callbacks.clear();
    for (const [, callback] of callbacks) callback(time);
  }
}
