// @vitest-environment jsdom

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  PointerReorder,
  type PointerReorderAxis,
  type PointerReorderBlock,
  type PointerReorderConfig,
} from "../../src/todos/ui/pointerReorder";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("PointerReorder", () => {
  it("preorders horizontal groups after the mouse threshold and commits only beforeGroupId", () => {
    const harness = createHarness("horizontal", [
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
    const source = harness.block("a").elements[0]!;
    source.setAttribute("style", "color: red");
    const reorder = harness.bind(source, "a");

    dispatchPointer(source, "pointerdown", { pointerId: 1, clientX: 40, clientY: 20 });
    dispatchPointer(window, "pointermove", { pointerId: 1, clientX: 43, clientY: 20 });
    expect(reorder.pending).toBe(true);
    expect(harness.groupOrder()).toEqual(["a", "b", "c"]);
    expect(document.querySelector(".todo-pointer-reorder-preview-layer")).toBeNull();

    dispatchPointer(window, "pointermove", { pointerId: 1, clientX: 190, clientY: 20 });
    expect(reorder.dragging).toBe(true);
    expect(reorder.activeGroupId).toBe("a");
    expect(harness.groupOrder()).toEqual(["b", "a", "c"]);
    expect(harness.block("c").elements[0]!.classList.contains("is-drop-target")).toBe(true);
    expect(harness.capture.set).toHaveBeenCalledWith(1);
    expect(harness.animate).toHaveBeenCalled();

    const layer = document.querySelector<SVGSVGElement>(
      ".todo-pointer-reorder-preview-layer",
    )!;
    const frame = layer.querySelector<SVGForeignObjectElement>("foreignObject")!;
    expect(frame.getAttribute("x")).not.toBeNull();
    expect(frame.getAttribute("y")).not.toBeNull();
    expect(frame.getAttribute("width")).not.toBe("0");
    expect(layer.querySelector("[style]")).toBeNull();
    expect(layer.querySelector("[data-pointer-reorder-clone]")).not.toBeNull();

    dispatchPointer(window, "pointerup", { pointerId: 1, clientX: 190, clientY: 20 });
    expect(harness.commit).toHaveBeenCalledOnce();
    expect(harness.commit).toHaveBeenCalledWith("c");
    expect(document.querySelector(".todo-pointer-reorder-preview-layer")).toBeNull();
    expect(harness.root.classList.contains("is-dragging")).toBe(false);
    expect(harness.container.classList.contains("is-reordering")).toBe(false);
    expect(harness.capture.release).toHaveBeenCalledWith(1);
    reorder.dispose();
  });

  it("moves every real member of a vertical dependency group as one block", () => {
    const harness = createHarness("vertical", [
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]);
    const members = harness.block("b").elements;
    const reorder = harness.bind(members[1]!, "b");

    dispatchPointer(members[1]!, "pointerdown", {
      pointerId: 2,
      clientX: 20,
      clientY: 220,
    });
    dispatchPointer(window, "pointermove", {
      pointerId: 2,
      clientX: 20,
      clientY: 10,
    });

    expect(harness.elementOrder()).toEqual(["b-0", "b-1", "a-0", "c-0"]);
    expect(members.every((member) => member.classList.contains("is-dragging"))).toBe(true);
    expect(harness.block("a").elements[0]!.classList.contains("is-drop-target")).toBe(true);
    dispatchPointer(window, "pointerup", { pointerId: 2, clientX: 20, clientY: 10 });
    expect(harness.commit).toHaveBeenCalledWith("a");
    expect(harness.elementOrder()).toEqual(["b-0", "b-1", "a-0", "c-0"]);
    reorder.dispose();
  });

  it("requires a stationary touch long press and cancels pending activation after movement", () => {
    vi.useFakeTimers();
    const harness = createHarness("horizontal", [["a", 1], ["b", 1]]);
    const source = harness.block("a").elements[0]!;
    const reorder = harness.bind(source, "a");

    dispatchPointer(source, "pointerdown", {
      pointerId: 3,
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
    });
    dispatchPointer(window, "pointermove", {
      pointerId: 3,
      pointerType: "touch",
      clientX: 29,
      clientY: 20,
    });
    vi.advanceTimersByTime(500);
    expect(reorder.pending).toBe(false);
    expect(reorder.dragging).toBe(false);
    expect(harness.capture.set).not.toHaveBeenCalled();

    dispatchPointer(source, "pointerdown", {
      pointerId: 4,
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
    });
    vi.advanceTimersByTime(419);
    expect(reorder.dragging).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reorder.dragging).toBe(true);
    expect(harness.capture.set).toHaveBeenCalledWith(4);
    dispatchPointer(window, "pointercancel", {
      pointerId: 4,
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
    });
    expect(reorder.dragging).toBe(false);
    expect(harness.commit).not.toHaveBeenCalled();
    reorder.dispose();
  });

  it("auto-scrolls on the configured axis and cancels its animation frame", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      callbacks.delete(id);
    });
    const harness = createHarness("horizontal", [["a", 1], ["b", 1], ["c", 1]]);
    const host = document.createElement("div");
    harness.root.insertBefore(host, harness.container);
    host.append(harness.container);
    mockRect(host, () => rectangle(0, 0, 100, 80));
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });
    const source = harness.block("a").elements[0]!;
    const reorder = harness.bind(source, "a", { scrollHost: host });

    dispatchPointer(source, "pointerdown", { pointerId: 5, clientX: 20, clientY: 20 });
    dispatchPointer(window, "pointermove", { pointerId: 5, clientX: 99, clientY: 20 });
    expect(request).toHaveBeenCalled();
    const first = [...callbacks.entries()][0]!;
    callbacks.delete(first[0]);
    first[1](16);
    expect(host.scrollLeft).toBeGreaterThan(0);

    dispatchPointer(window, "pointercancel", { pointerId: 5, clientX: 99, clientY: 20 });
    expect(cancel).toHaveBeenCalled();
    expect(host.classList.contains("is-reordering")).toBe(false);
    expect(callbacks.size).toBe(0);
    reorder.dispose();
  });

  it("uses window events when pointer capture is unavailable", () => {
    const harness = createHarness("horizontal", [["a", 1], ["b", 1], ["c", 1]]);
    harness.capture.set.mockImplementation(() => {
      throw new Error("capture unavailable");
    });
    const source = harness.block("a").elements[0]!;
    const reorder = harness.bind(source, "a");
    dispatchPointer(source, "pointerdown", { pointerId: 6, clientX: 20, clientY: 20 });
    dispatchPointer(window, "pointermove", { pointerId: 6, clientX: 190, clientY: 20 });
    dispatchPointer(window, "pointerup", { pointerId: 6, clientX: 190, clientY: 20 });
    expect(harness.commit).toHaveBeenCalledWith("c");
    expect(reorder.dragging).toBe(false);
    reorder.dispose();
  });

  it("restores order on lost capture and Escape", () => {
    const lost = createHarness("horizontal", [["a", 1], ["b", 1], ["c", 1]]);
    const lostSource = lost.block("a").elements[0]!;
    const lostReorder = lost.bind(lostSource, "a");
    dispatchPointer(lostSource, "pointerdown", { pointerId: 7, clientX: 20, clientY: 20 });
    dispatchPointer(window, "pointermove", { pointerId: 7, clientX: 190, clientY: 20 });
    expect(lost.groupOrder()).toEqual(["b", "a", "c"]);
    dispatchPointer(lost.container, "lostpointercapture", {
      pointerId: 7,
      clientX: 190,
      clientY: 20,
    });
    expect(lost.groupOrder()).toEqual(["a", "b", "c"]);
    expect(lost.commit).not.toHaveBeenCalled();
    lostReorder.dispose();

    const escaped = createHarness("vertical", [["a", 1], ["b", 1], ["c", 1]]);
    const escapedSource = escaped.block("a").elements[0]!;
    const escapedReorder = escaped.bind(escapedSource, "a");
    dispatchPointer(escapedSource, "pointerdown", {
      pointerId: 8,
      clientX: 20,
      clientY: 20,
    });
    dispatchPointer(window, "pointermove", {
      pointerId: 8,
      clientX: 20,
      clientY: 190,
    });
    const escape = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(escaped.groupOrder()).toEqual(["a", "b", "c"]);
    expect(escaped.commit).not.toHaveBeenCalled();
    escapedReorder.dispose();
  });

  it("dispose cancels active state, restores DOM, capture, preview, and source listeners", () => {
    const harness = createHarness("horizontal", [["a", 1], ["b", 1], ["c", 1]]);
    const source = harness.block("a").elements[0]!;
    const reorder = harness.bind(source, "a");
    dispatchPointer(source, "pointerdown", { pointerId: 9, clientX: 20, clientY: 20 });
    dispatchPointer(window, "pointermove", { pointerId: 9, clientX: 190, clientY: 20 });
    expect(harness.groupOrder()).toEqual(["b", "a", "c"]);

    reorder.dispose();
    expect(harness.groupOrder()).toEqual(["a", "b", "c"]);
    expect(harness.capture.release).toHaveBeenCalledWith(9);
    expect(document.querySelector(".todo-pointer-reorder-preview-layer")).toBeNull();
    expect(harness.container.querySelector(".is-dragging, .is-drop-target")).toBeNull();
    expect(harness.root.classList.contains("is-dragging")).toBe(false);

    dispatchPointer(source, "pointerdown", { pointerId: 10, clientX: 20, clientY: 20 });
    dispatchPointer(window, "pointermove", { pointerId: 10, clientX: 190, clientY: 20 });
    expect(reorder.dragging).toBe(false);
    expect(harness.commit).not.toHaveBeenCalled();
  });
});

interface Harness {
  readonly root: HTMLElement;
  readonly container: HTMLElement;
  readonly blocks: readonly PointerReorderBlock[];
  readonly commit: ReturnType<typeof vi.fn<(beforeGroupId: string | null) => void>>;
  readonly redraw: ReturnType<typeof vi.fn<() => void>>;
  readonly animate: ReturnType<typeof vi.fn>;
  readonly capture: {
    readonly set: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
    readonly release: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
  };
  readonly block: (groupId: string) => PointerReorderBlock;
  readonly elementOrder: () => string[];
  readonly groupOrder: () => string[];
  readonly bind: (
    source: HTMLElement,
    groupId: string,
    overrides?: Partial<PointerReorderConfig>,
  ) => PointerReorder;
}

function createHarness(
  axis: PointerReorderAxis,
  specs: ReadonlyArray<readonly [groupId: string, memberCount: number]>,
): Harness {
  const root = document.createElement("main");
  const container = document.createElement("div");
  root.append(container);
  document.body.append(root);
  const animate = vi.fn(() => ({
    cancel: vi.fn(),
    finished: new Promise<void>(() => undefined),
  }) as unknown as Animation);
  const blocks = specs.map(([groupId, count]) => {
    const elements = Array.from({ length: count }, (_, index) => {
      const element = document.createElement("button");
      element.type = "button";
      element.dataset.testId = `${groupId}-${index}`;
      element.textContent = `${groupId}-${index}`;
      Object.defineProperty(element, "animate", { configurable: true, value: animate });
      mockRect(element, () => {
        const siblings = htmlChildren(container);
        const position = siblings.indexOf(element);
        return axis === "horizontal"
          ? rectangle(position * 100, 0, 80, 40)
          : rectangle(0, position * 100, 80, 40);
      });
      container.append(element);
      return element;
    });
    return { groupId, elements } satisfies PointerReorderBlock;
  });
  mockRect(root, () => rectangle(0, 0, 500, 500));
  mockRect(container, () => rectangle(0, 0, 500, 500));
  const captured = new Set<number>();
  const set = vi.fn((pointerId: number) => { captured.add(pointerId); });
  const release = vi.fn((pointerId: number) => { captured.delete(pointerId); });
  Object.defineProperties(container, {
    setPointerCapture: { configurable: true, value: set },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.has(pointerId),
    },
    releasePointerCapture: { configurable: true, value: release },
  });
  const commit = vi.fn<(beforeGroupId: string | null) => void>();
  const redraw = vi.fn<() => void>();
  const block = (groupId: string): PointerReorderBlock => {
    const found = blocks.find((candidate) => candidate.groupId === groupId);
    if (!found) throw new Error(`Missing test block ${groupId}`);
    return found;
  };
  return {
    root,
    container,
    blocks,
    commit,
    redraw,
    animate,
    capture: { set, release },
    block,
    elementOrder: () => htmlChildren(container).map((element) => element.dataset.testId!),
    groupOrder: () => {
      const order = htmlChildren(container).map((element) => element.dataset.testId!.split("-")[0]!);
      return order.filter((groupId, index) => order[index - 1] !== groupId);
    },
    bind: (source, groupId, overrides = {}) => {
      const reorder = new PointerReorder({ root });
      reorder.bind(source, () => ({
        axis,
        groupId,
        container,
        blocks,
        captureTarget: container,
        onLayoutChange: redraw,
        onCommit: commit,
        ...overrides,
      }));
      return reorder;
    },
  };
}

function htmlChildren(container: HTMLElement): HTMLElement[] {
  return [...container.children].filter((element): element is HTMLElement =>
    element instanceof HTMLElement);
}

function mockRect(element: Element, read: () => DOMRect): void {
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(read);
}

function rectangle(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

interface PointerInit {
  readonly pointerId: number;
  readonly pointerType?: string;
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
    pointerType: { configurable: true, value: init.pointerType ?? "mouse" },
    isPrimary: { configurable: true, value: true },
  });
  target.dispatchEvent(event);
  return event;
}
