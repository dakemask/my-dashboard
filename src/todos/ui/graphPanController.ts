const DEFAULT_DIRECTION_THRESHOLD = 8;
const DEFAULT_CLICK_SUPPRESSION_MS = 500;
const DEFAULT_INERTIA_MIN_VELOCITY = 0.01;
const DEFAULT_INERTIA_DECAY_PER_FRAME = 0.93;
const DEFAULT_MOUSE_BLOCK_SELECTOR = ".todo-task-node";
const DEFAULT_CLICK_TARGET_SELECTOR = "button, input, a";

export interface GraphPanFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface GraphPanControllerOptions {
  readonly root: HTMLElement;
  readonly directionThreshold?: number;
  readonly clickSuppressionMs?: number;
  readonly inertiaMinVelocity?: number;
  readonly inertiaDecayPerFrame?: number;
  readonly animationFrames?: GraphPanFrameScheduler;
  readonly now?: () => number;
}

export interface GraphPanBindingOptions {
  /** Mouse drags beginning inside this selector remain available to the graph content. */
  readonly mouseBlockSelector?: string;
  /** A touch pan suppresses only the click belonging to this original target. */
  readonly clickTargetSelector?: string;
  /** Used by another pointer owner, such as a long-press reorder controller. */
  readonly isInteractionBlocked?: () => boolean;
  /** Cancels another pending pointer intent once touch direction is known. */
  readonly cancelPendingInteraction?: () => void;
  readonly onScrollLeftChange?: (scrollLeft: number) => void;
}

interface GraphPanBinding {
  readonly graph: HTMLElement;
  readonly options: GraphPanBindingOptions;
  readonly pointerDown: EventListener;
  readonly wheel: EventListener;
  readonly lostPointerCapture: EventListener;
}

interface GraphPanSession {
  readonly binding: GraphPanBinding;
  readonly pointerId: number;
  readonly pointerType: "mouse" | "touch";
  readonly startX: number;
  readonly startY: number;
  readonly startScrollLeft: number;
  readonly clickTarget: Element | null;
  panning: boolean;
  lastScrollLeft: number;
  lastSampleTime: number;
  velocity: number;
}

interface GraphPanInertia {
  readonly binding: GraphPanBinding;
  frame: number;
  velocity: number;
  previousTime: number;
}

interface ClickSuppression {
  readonly binding: GraphPanBinding;
  readonly dispose: () => void;
}

/**
 * Pointer navigation shared by all horizontally scrollable task graphs.
 * It owns interaction state only; graph DOM, data, and saved scroll state stay with the caller.
 */
export class GraphPanController {
  readonly #window: Window & typeof globalThis;
  readonly #directionThreshold: number;
  readonly #clickSuppressionMs: number;
  readonly #inertiaMinVelocity: number;
  readonly #inertiaDecayPerFrame: number;
  readonly #frames: GraphPanFrameScheduler;
  readonly #now: () => number;
  readonly #bindings = new Map<HTMLElement, GraphPanBinding>();
  readonly #clickSuppressions = new Set<ClickSuppression>();
  #session: GraphPanSession | null = null;
  #inertia: GraphPanInertia | null = null;
  #disposed = false;

  readonly #handlePointerMove = (event: Event): void => {
    this.#onPointerMove(event as PointerEvent);
  };

  readonly #handlePointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.#session?.pointerId === pointerEvent.pointerId) this.#finish(true);
  };

  readonly #handlePointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    if (this.#session?.pointerId === pointerEvent.pointerId) this.#finish(false);
  };

  constructor(options: GraphPanControllerOptions) {
    const pageWindow = options.root.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Graph pan window is unavailable.");
    this.#window = pageWindow;
    this.#directionThreshold = nonNegativeNumber(
      options.directionThreshold,
      DEFAULT_DIRECTION_THRESHOLD,
    );
    this.#clickSuppressionMs = nonNegativeNumber(
      options.clickSuppressionMs,
      DEFAULT_CLICK_SUPPRESSION_MS,
    );
    this.#inertiaMinVelocity = nonNegativeNumber(
      options.inertiaMinVelocity,
      DEFAULT_INERTIA_MIN_VELOCITY,
    );
    this.#inertiaDecayPerFrame = fraction(
      options.inertiaDecayPerFrame,
      DEFAULT_INERTIA_DECAY_PER_FRAME,
    );
    this.#frames = options.animationFrames ?? {
      request: (callback) => this.#window.requestAnimationFrame(callback),
      cancel: (handle) => this.#window.cancelAnimationFrame(handle),
    };
    this.#now = options.now ?? (() => this.#window.performance.now());

    this.#window.addEventListener("pointermove", this.#handlePointerMove, { passive: false });
    this.#window.addEventListener("pointerup", this.#handlePointerUp);
    this.#window.addEventListener("pointercancel", this.#handlePointerCancel);
  }

  get panning(): boolean {
    return this.#session?.panning === true;
  }

  bind(graph: HTMLElement, options: GraphPanBindingOptions = {}): () => void {
    if (this.#disposed) throw new Error("Graph pan controller has been disposed.");
    this.unbind(graph);
    let binding: GraphPanBinding;
    const pointerDown: EventListener = (event) => {
      this.#onPointerDown(binding, event as PointerEvent);
    };
    const wheel: EventListener = (event) => {
      this.#onWheel(binding, event as WheelEvent);
    };
    const lostPointerCapture: EventListener = (event) => {
      const pointerEvent = event as PointerEvent;
      if (this.#session?.binding === binding
        && this.#session.pointerId === pointerEvent.pointerId) {
        this.#finish(false);
      }
    };
    binding = { graph, options, pointerDown, wheel, lostPointerCapture };
    this.#bindings.set(graph, binding);
    graph.addEventListener("pointerdown", pointerDown);
    graph.addEventListener("wheel", wheel, { passive: false });
    graph.addEventListener("lostpointercapture", lostPointerCapture);
    return () => {
      if (this.#bindings.get(graph) === binding) this.unbind(graph);
    };
  }

  unbind(graph: HTMLElement): void {
    const binding = this.#bindings.get(graph);
    if (!binding) return;
    if (this.#session?.binding === binding) this.#finish(false);
    if (this.#inertia?.binding === binding) this.#stopInertia();
    for (const suppression of [...this.#clickSuppressions]) {
      if (suppression.binding === binding) suppression.dispose();
    }
    graph.removeEventListener("pointerdown", binding.pointerDown);
    graph.removeEventListener("wheel", binding.wheel);
    graph.removeEventListener("lostpointercapture", binding.lostPointerCapture);
    graph.classList.remove("is-panning");
    this.#bindings.delete(graph);
  }

  cancel(): void {
    this.#finish(false);
    this.#stopInertia();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
    for (const graph of [...this.#bindings.keys()]) this.unbind(graph);
    for (const suppression of [...this.#clickSuppressions]) suppression.dispose();
    this.#window.removeEventListener("pointermove", this.#handlePointerMove);
    this.#window.removeEventListener("pointerup", this.#handlePointerUp);
    this.#window.removeEventListener("pointercancel", this.#handlePointerCancel);
  }

  #onWheel(binding: GraphPanBinding, event: WheelEvent): void {
    const { graph, options } = binding;
    if (this.#bindings.get(graph) !== binding
      || options.isInteractionBlocked?.()
      || graph.scrollWidth <= graph.clientWidth) return;
    const movement = event.deltaX + event.deltaY;
    if (movement === 0) return;
    this.#stopInertia();
    event.preventDefault();
    const before = graph.scrollLeft;
    graph.scrollLeft += movement;
    this.#notifyScroll(binding, before);
  }

  #onPointerDown(binding: GraphPanBinding, event: PointerEvent): void {
    if (this.#disposed
      || this.#session
      || event.isPrimary === false
      || event.button !== 0) return;
    // Any deliberate pointer interaction stops a gliding graph, even when the
    // target belongs to task content or another pointer owner handles it.
    this.#stopInertia();
    if (binding.options.isInteractionBlocked?.()) return;
    const target = event.target instanceof this.#window.Element ? event.target : null;
    const pointerType = event.pointerType === "touch" ? "touch" : "mouse";
    if (pointerType === "mouse") {
      const selector = binding.options.mouseBlockSelector ?? DEFAULT_MOUSE_BLOCK_SELECTOR;
      if (target?.closest(selector)) return;
    }
    const graph = binding.graph;
    const now = this.#now();
    const clickSelector = binding.options.clickTargetSelector ?? DEFAULT_CLICK_TARGET_SELECTOR;
    const session: GraphPanSession = {
      binding,
      pointerId: event.pointerId,
      pointerType,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: graph.scrollLeft,
      clickTarget: pointerType === "touch" ? target?.closest(clickSelector) ?? null : null,
      panning: pointerType === "mouse",
      lastScrollLeft: graph.scrollLeft,
      lastSampleTime: now,
      velocity: 0,
    };
    this.#session = session;
    if (session.panning) {
      graph.classList.add("is-panning");
      this.#capture(session);
      event.preventDefault();
    }
  }

  #onPointerMove(event: PointerEvent): void {
    const session = this.#session;
    if (!session || session.pointerId !== event.pointerId) return;
    const { binding } = session;
    const { graph, options } = binding;
    if (this.#bindings.get(graph) !== binding || !graph.isConnected) {
      this.#finish(false);
      return;
    }
    if (options.isInteractionBlocked?.()) return;
    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    if (session.pointerType === "touch" && !session.panning) {
      if (Math.hypot(deltaX, deltaY) < this.#directionThreshold) return;
      options.cancelPendingInteraction?.();
      if (Math.abs(deltaY) >= Math.abs(deltaX)) {
        this.#finish(false);
        return;
      }
      session.panning = true;
      graph.classList.add("is-panning");
      this.#capture(session);
    }
    if (!session.panning) return;
    event.preventDefault();
    const before = graph.scrollLeft;
    graph.scrollLeft = session.startScrollLeft - deltaX;
    this.#notifyScroll(binding, before);
    if (session.pointerType === "touch") this.#sampleVelocity(session);
  }

  #sampleVelocity(session: GraphPanSession): void {
    const now = this.#now();
    const graph = session.binding.graph;
    const elapsed = Math.max(1, Math.min(80, now - session.lastSampleTime));
    const instantVelocity = (graph.scrollLeft - session.lastScrollLeft) / elapsed;
    session.velocity = clamp(session.velocity * 0.58 + instantVelocity * 0.42, -3, 3);
    session.lastScrollLeft = graph.scrollLeft;
    session.lastSampleTime = now;
  }

  #finish(allowInertia: boolean): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    const { binding } = session;
    const completedTouchPan = session.pointerType === "touch" && session.panning;
    const recentVelocity = this.#now() - session.lastSampleTime > 80 ? 0 : session.velocity;
    this.#release(session);
    binding.graph.classList.remove("is-panning");
    if (!completedTouchPan) return;
    if (session.clickTarget) this.#suppressNextClick(binding, session.clickTarget);
    if (allowInertia) this.#startInertia(binding, recentVelocity);
  }

  #capture(session: GraphPanSession): void {
    try {
      session.binding.graph.setPointerCapture(session.pointerId);
    } catch {
      // Window listeners keep navigation active when capture is unavailable.
    }
  }

  #release(session: GraphPanSession): void {
    try {
      if (session.binding.graph.hasPointerCapture(session.pointerId)) {
        session.binding.graph.releasePointerCapture(session.pointerId);
      }
    } catch {
      // A graph can be disconnected while its pointer sequence is ending.
    }
  }

  #startInertia(binding: GraphPanBinding, initialVelocity: number): void {
    this.#stopInertia();
    if (!binding.graph.isConnected || Math.abs(initialVelocity) < this.#inertiaMinVelocity) return;
    const inertia: GraphPanInertia = {
      binding,
      frame: 0,
      velocity: initialVelocity,
      previousTime: this.#now(),
    };
    const tick = (time: number): void => {
      if (this.#inertia !== inertia
        || this.#bindings.get(binding.graph) !== binding
        || !binding.graph.isConnected) {
        if (this.#inertia === inertia) this.#inertia = null;
        return;
      }
      const elapsed = Math.max(1, Math.min(32, time - inertia.previousTime));
      inertia.previousTime = time;
      const before = binding.graph.scrollLeft;
      binding.graph.scrollLeft += inertia.velocity * elapsed;
      this.#notifyScroll(binding, before);
      inertia.velocity *= Math.pow(
        this.#inertiaDecayPerFrame,
        elapsed / (1000 / 60),
      );
      if (binding.graph.scrollLeft === before
        || Math.abs(inertia.velocity) < this.#inertiaMinVelocity) {
        this.#inertia = null;
        return;
      }
      inertia.frame = this.#frames.request(tick);
    };
    inertia.frame = this.#frames.request(tick);
    this.#inertia = inertia;
  }

  #stopInertia(): void {
    const inertia = this.#inertia;
    if (!inertia) return;
    this.#inertia = null;
    this.#frames.cancel(inertia.frame);
  }

  #notifyScroll(binding: GraphPanBinding, before: number): void {
    const after = binding.graph.scrollLeft;
    if (after !== before) binding.options.onScrollLeftChange?.(after);
  }

  #suppressNextClick(binding: GraphPanBinding, target: Element): void {
    let timeout = 0;
    let disposed = false;
    const listener = (event: Event): void => {
      const eventTarget = event.target instanceof this.#window.Element ? event.target : null;
      if (!eventTarget
        || !binding.graph.contains(eventTarget)
        || !target.contains(eventTarget)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppression.dispose();
    };
    const suppression: ClickSuppression = {
      binding,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#window.removeEventListener("click", listener, true);
        if (timeout !== 0) this.#window.clearTimeout(timeout);
        this.#clickSuppressions.delete(suppression);
      },
    };
    this.#clickSuppressions.add(suppression);
    this.#window.addEventListener("click", listener, true);
    timeout = this.#window.setTimeout(suppression.dispose, this.#clickSuppressionMs);
  }
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function fraction(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
    ? value
    : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
