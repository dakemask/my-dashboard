const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const DEFAULT_MOVEMENT_THRESHOLD = 5;
const DEFAULT_TOUCH_MOVEMENT_TOLERANCE = 8;
const DEFAULT_TOUCH_LONG_PRESS_MS = 420;
const AUTO_SCROLL_CROSS_AXIS_MARGIN = 24;
const AUTO_SCROLL_MAX_ZONE = 56;
const AUTO_SCROLL_ZONE_RATIO = 0.18;
const AUTO_SCROLL_MIN_SPEED = 2;
const AUTO_SCROLL_SPEED_RANGE = 16;

export type PointerReorderAxis = "horizontal" | "vertical";
export type PointerReorderTouchActivation = "long-press" | "movement";

export interface PointerReorderBlock {
  readonly groupId: string;
  readonly elements: readonly HTMLElement[];
}

export interface PointerReorderConfig {
  readonly axis: PointerReorderAxis;
  readonly groupId: string;
  readonly container: HTMLElement;
  readonly blocks: readonly PointerReorderBlock[];
  readonly captureTarget?: HTMLElement;
  readonly scrollHost?: HTMLElement | null;
  readonly previewHost?: HTMLElement | null;
  readonly stateHost?: HTMLElement;
  readonly touchActivation?: PointerReorderTouchActivation;
  readonly canStart?: (event: PointerEvent) => boolean;
  readonly onLayoutChange?: () => void;
  readonly onCommit: (beforeGroupId: string | null) => void;
}

export interface PointerReorderOptions {
  readonly root: HTMLElement;
  readonly movementThreshold?: number;
  readonly touchMovementTolerance?: number;
  readonly touchLongPressMs?: number;
}

interface NormalizedBlocks {
  readonly blocks: readonly MutableBlock[];
  readonly elements: readonly HTMLElement[];
  readonly groupByElement: ReadonlyMap<HTMLElement, string>;
}

interface MutableBlock {
  readonly groupId: string;
  readonly elements: HTMLElement[];
}

interface PointerPreview {
  readonly layer: SVGSVGElement;
  readonly frame: SVGForeignObjectElement;
  readonly mount: HTMLElement;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

interface PointerReorderSession {
  readonly source: HTMLElement;
  readonly config: PointerReorderConfig;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly requiresLongPress: boolean;
  readonly startX: number;
  readonly startY: number;
  readonly downTarget: Element | null;
  readonly allElements: readonly HTMLElement[];
  readonly groupByElement: ReadonlyMap<HTMLElement, string>;
  readonly members: readonly HTMLElement[];
  readonly originalBeforeGroupId: string | null;
  readonly markers: Map<HTMLElement, Comment>;
  readonly animations: Animation[];
  active: boolean;
  lastX: number;
  lastY: number;
  longPressTimer: number | null;
  autoScrollFrame: number | null;
  preview: PointerPreview | null;
}

interface GroupPosition {
  readonly found: boolean;
  readonly beforeGroupId: string | null;
}

interface ClickSuppression {
  readonly dispose: () => void;
}

export class PointerReorder {
  readonly #root: HTMLElement;
  readonly #document: Document;
  readonly #window: Window & typeof globalThis;
  readonly #movementThreshold: number;
  readonly #touchMovementTolerance: number;
  readonly #touchLongPressMs: number;
  readonly #bindings = new Map<HTMLElement, EventListener>();
  readonly #animations = new Set<Animation>();
  readonly #clickSuppressions = new Set<ClickSuppression>();
  #session: PointerReorderSession | null = null;
  #disposed = false;

  readonly #handlePointerMove = (event: Event): void => {
    this.#onPointerMove(event as PointerEvent);
  };

  readonly #handlePointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    const session = this.#matchingSession(pointerEvent);
    if (session) this.#finish(session.active);
  };

  readonly #handlePointerCancel = (event: Event): void => {
    if (this.#matchingSession(event as PointerEvent)) this.cancel();
  };

  readonly #handleLostPointerCapture = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    const session = this.#matchingSession(pointerEvent);
    if (session && event.target === session.config.captureTarget) this.cancel();
  };

  readonly #handleKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Escape" || !this.#session) return;
    keyboardEvent.preventDefault();
    this.cancel();
  };

  constructor(options: PointerReorderOptions) {
    this.#root = options.root;
    this.#document = options.root.ownerDocument;
    const pageWindow = this.#document.defaultView;
    if (!pageWindow) throw new Error("Pointer reorder window is unavailable.");
    this.#window = pageWindow;
    this.#movementThreshold = positiveNumber(
      options.movementThreshold,
      DEFAULT_MOVEMENT_THRESHOLD,
    );
    this.#touchMovementTolerance = positiveNumber(
      options.touchMovementTolerance,
      DEFAULT_TOUCH_MOVEMENT_TOLERANCE,
    );
    this.#touchLongPressMs = nonNegativeNumber(
      options.touchLongPressMs,
      DEFAULT_TOUCH_LONG_PRESS_MS,
    );

    this.#window.addEventListener("pointermove", this.#handlePointerMove, { passive: false });
    this.#window.addEventListener("pointerup", this.#handlePointerUp);
    this.#window.addEventListener("pointercancel", this.#handlePointerCancel);
    this.#window.addEventListener("lostpointercapture", this.#handleLostPointerCapture, true);
    this.#window.addEventListener("keydown", this.#handleKeyDown);
  }

  get dragging(): boolean {
    return this.#session?.active === true;
  }

  get pending(): boolean {
    return this.#session !== null && !this.#session.active;
  }

  get activeGroupId(): string | null {
    return this.#session?.active ? this.#session.config.groupId : null;
  }

  bind(source: HTMLElement, resolve: () => PointerReorderConfig | null): () => void {
    if (this.#disposed) throw new Error("Pointer reorder has been disposed.");
    this.#unbind(source);
    const listener: EventListener = (event) => {
      this.#onPointerDown(source, resolve, event as PointerEvent);
    };
    source.addEventListener("pointerdown", listener);
    this.#bindings.set(source, listener);
    return () => this.#unbind(source);
  }

  cancel(): void {
    this.#finish(false);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
    for (const [source, listener] of this.#bindings) {
      source.removeEventListener("pointerdown", listener);
    }
    this.#bindings.clear();
    this.#window.removeEventListener("pointermove", this.#handlePointerMove);
    this.#window.removeEventListener("pointerup", this.#handlePointerUp);
    this.#window.removeEventListener("pointercancel", this.#handlePointerCancel);
    this.#window.removeEventListener("lostpointercapture", this.#handleLostPointerCapture, true);
    this.#window.removeEventListener("keydown", this.#handleKeyDown);
    for (const suppression of [...this.#clickSuppressions]) suppression.dispose();
    for (const animation of this.#animations) animation.cancel();
    this.#animations.clear();
  }

  #unbind(source: HTMLElement): void {
    const listener = this.#bindings.get(source);
    if (!listener) return;
    if (this.#session?.source === source) this.cancel();
    source.removeEventListener("pointerdown", listener);
    this.#bindings.delete(source);
  }

  #onPointerDown(
    source: HTMLElement,
    resolve: () => PointerReorderConfig | null,
    event: PointerEvent,
  ): void {
    if (this.#disposed || this.#session || event.isPrimary === false || event.button !== 0) return;
    const target = event.target instanceof this.#window.Element ? event.target : null;
    if (target && isIgnoredTarget(target, source)) return;
    const config = resolve();
    if (!config || config.canStart?.(event) === false) return;
    const normalized = normalizeBlocks(config);
    const dragged = normalized?.blocks.find((block) => block.groupId === config.groupId);
    if (!normalized || !dragged) return;
    const captureTarget = config.captureTarget ?? source;
    const resolvedConfig: PointerReorderConfig = { ...config, captureTarget };
    const pointerType = event.pointerType || "mouse";
    const requiresLongPress = pointerType === "touch"
      && (config.touchActivation ?? "long-press") === "long-press";
    const originalPosition = groupPosition(normalized.blocks, config.groupId);
    if (!originalPosition.found) return;
    const session: PointerReorderSession = {
      source,
      config: resolvedConfig,
      pointerId: event.pointerId,
      pointerType,
      requiresLongPress,
      startX: event.clientX,
      startY: event.clientY,
      downTarget: target,
      allElements: normalized.elements,
      groupByElement: normalized.groupByElement,
      members: dragged.elements,
      originalBeforeGroupId: originalPosition.beforeGroupId,
      markers: new Map(),
      animations: [],
      active: false,
      lastX: event.clientX,
      lastY: event.clientY,
      longPressTimer: null,
      autoScrollFrame: null,
      preview: null,
    };
    this.#session = session;
    if (!requiresLongPress) return;
    session.longPressTimer = this.#window.setTimeout(() => {
      if (this.#session !== session || session.active || !session.source.isConnected) return;
      const distance = pointerDistance(session, session.lastX, session.lastY);
      if (distance < this.#touchMovementTolerance) this.#activate(session);
    }, this.#touchLongPressMs);
  }

  #onPointerMove(event: PointerEvent): void {
    const session = this.#matchingSession(event);
    if (!session) return;
    session.lastX = event.clientX;
    session.lastY = event.clientY;
    if (!session.source.isConnected || !session.config.container.isConnected) {
      this.cancel();
      return;
    }
    if (!session.active) {
      const distance = pointerDistance(session, event.clientX, event.clientY);
      if (session.requiresLongPress) {
        if (distance >= this.#touchMovementTolerance) this.cancel();
        return;
      }
      const threshold = session.pointerType === "touch"
        ? this.#touchMovementTolerance
        : this.#movementThreshold;
      if (distance >= threshold) this.#activate(session);
    }
    if (!session.active) return;
    event.preventDefault();
    this.#updateLayout(session);
  }

  #matchingSession(event: PointerEvent): PointerReorderSession | null {
    const session = this.#session;
    return session?.pointerId === event.pointerId ? session : null;
  }

  #activate(session: PointerReorderSession): void {
    if (this.#session !== session || session.active) return;
    this.#clearLongPress(session);
    session.active = true;
    for (const element of session.allElements) {
      const marker = this.#document.createComment("pointer-reorder-position");
      session.config.container.insertBefore(marker, element);
      session.markers.set(element, marker);
    }
    try {
      session.config.captureTarget?.setPointerCapture(session.pointerId);
    } catch {
      // Window listeners are the fallback when capture is unavailable.
    }
    session.preview = this.#createPreview(session);
    (session.config.stateHost ?? this.#root).classList.add("is-dragging");
    session.config.container.classList.add("is-reordering");
    session.config.scrollHost?.classList.add("is-reordering");
    for (const member of session.members) member.classList.add("is-dragging");
    session.config.onLayoutChange?.();
    this.#updateLayout(session);
    if (session.config.scrollHost) this.#startAutoScroll(session);
  }

  #createPreview(session: PointerReorderSession): PointerPreview {
    const bounds = boundsOf(session.members);
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const mount = session.config.previewHost
      ?? session.source.closest<HTMLElement>("dialog[open]")
      ?? this.#root;
    const layer = this.#document.createElementNS(SVG_NAMESPACE, "svg");
    layer.classList.add("todo-pointer-reorder-preview-layer");
    layer.dataset.axis = session.config.axis;
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("focusable", "false");
    layer.setAttribute("preserveAspectRatio", "none");
    const frame = this.#document.createElementNS(SVG_NAMESPACE, "foreignObject");
    frame.classList.add("todo-pointer-reorder-preview");
    frame.dataset.kind = session.config.axis === "horizontal" ? "graph" : "editor";
    frame.setAttribute("width", String(width));
    frame.setAttribute("height", String(height));
    const content = this.#document.createElement("div");
    content.className = "todo-pointer-reorder-preview-content";
    content.setAttribute("inert", "");
    for (const member of session.members) {
      const clone = sanitizePreviewClone(member.cloneNode(true) as HTMLElement);
      content.append(clone);
    }
    frame.append(content);
    layer.append(frame);
    mount.append(layer);
    const preview: PointerPreview = {
      layer,
      frame,
      mount,
      width,
      height,
      offsetX: clamp(session.lastX - bounds.left, 0, width),
      offsetY: clamp(session.lastY - bounds.top, 0, height),
    };
    this.#positionPreview(session, preview);
    return preview;
  }

  #positionPreview(session: PointerReorderSession, preview = session.preview): void {
    if (!preview) return;
    const rootMount = preview.mount === this.#document.body
      || preview.mount === this.#document.documentElement;
    const mountRect = rootMount ? null : preview.mount.getBoundingClientRect();
    const originX = mountRect?.left ?? 0;
    const originY = mountRect?.top ?? 0;
    const viewportWidth = Math.max(1, mountRect?.width || this.#window.innerWidth);
    const viewportHeight = Math.max(1, mountRect?.height || this.#window.innerHeight);
    preview.layer.setAttribute("width", String(viewportWidth));
    preview.layer.setAttribute("height", String(viewportHeight));
    preview.layer.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);
    preview.frame.setAttribute("x", String(session.lastX - preview.offsetX - originX));
    preview.frame.setAttribute("y", String(session.lastY - preview.offsetY - originY));
  }

  #updateLayout(session: PointerReorderSession): void {
    if (this.#session !== session || !session.active) return;
    this.#positionPreview(session);
    const blocks = this.#currentBlocks(session);
    const candidates = blocks.filter((block) => block.groupId !== session.config.groupId);
    const coordinate = session.config.axis === "horizontal" ? session.lastX : session.lastY;
    const target = candidates.find((block) => {
      const bounds = boundsOf(block.elements);
      const start = session.config.axis === "horizontal" ? bounds.left : bounds.top;
      const end = session.config.axis === "horizontal" ? bounds.right : bounds.bottom;
      return coordinate < (start + end) / 2;
    }) ?? null;
    this.#markDropTarget(session, target?.elements ?? []);
    const current = groupPosition(blocks, session.config.groupId);
    const nextBeforeGroupId = target?.groupId ?? null;
    if (!current.found || current.beforeGroupId === nextBeforeGroupId) return;

    this.#cancelSessionAnimations(session);
    const before = rectMap(session.allElements);
    const fragment = this.#document.createDocumentFragment();
    for (const member of session.members) fragment.append(member);
    session.config.container.insertBefore(fragment, target?.elements[0] ?? null);
    session.config.onLayoutChange?.();
    this.#animateFromRects(session.allElements, before, session);
  }

  #currentBlocks(session: PointerReorderSession): MutableBlock[] {
    const blocks: MutableBlock[] = [];
    for (const child of session.config.container.children) {
      if (!(child instanceof this.#window.HTMLElement)) continue;
      const groupId = session.groupByElement.get(child);
      if (!groupId) continue;
      const current = blocks[blocks.length - 1];
      if (current?.groupId === groupId) current.elements.push(child);
      else blocks.push({ groupId, elements: [child] });
    }
    return blocks;
  }

  #markDropTarget(session: PointerReorderSession, targets: readonly HTMLElement[]): void {
    for (const element of session.allElements) element.classList.remove("is-drop-target");
    session.config.container.classList.toggle("is-drop-at-end", targets.length === 0);
    for (const target of targets) target.classList.add("is-drop-target");
  }

  #animateFromRects(
    elements: readonly HTMLElement[],
    before: ReadonlyMap<HTMLElement, DOMRect>,
    session?: PointerReorderSession,
  ): void {
    for (const element of elements) {
      const previous = before.get(element);
      if (!previous || typeof element.animate !== "function") continue;
      const current = element.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      const animation = element.animate([
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" },
      ], {
        duration: 180,
        easing: "cubic-bezier(.22, 1, .36, 1)",
      });
      this.#animations.add(animation);
      session?.animations.push(animation);
      void animation.finished.then(
        () => this.#animations.delete(animation),
        () => this.#animations.delete(animation),
      );
    }
  }

  #cancelSessionAnimations(session: PointerReorderSession): void {
    for (const animation of session.animations.splice(0)) {
      this.#animations.delete(animation);
      animation.cancel();
    }
  }

  #startAutoScroll(session: PointerReorderSession): void {
    const tick = (): void => {
      if (this.#session !== session || !session.active || !session.config.scrollHost) return;
      const host = session.config.scrollHost;
      const velocity = autoScrollVelocity(
        session.config.axis,
        host.getBoundingClientRect(),
        session.lastX,
        session.lastY,
      );
      if (velocity !== 0) {
        const horizontal = session.config.axis === "horizontal";
        const before = horizontal ? host.scrollLeft : host.scrollTop;
        const maximum = Math.max(0, horizontal
          ? host.scrollWidth - host.clientWidth
          : host.scrollHeight - host.clientHeight);
        const after = clamp(before + velocity, 0, maximum);
        if (horizontal) host.scrollLeft = after;
        else host.scrollTop = after;
        if (after !== before) {
          session.config.onLayoutChange?.();
          this.#updateLayout(session);
        }
      }
      session.autoScrollFrame = this.#window.requestAnimationFrame(tick);
    };
    session.autoScrollFrame = this.#window.requestAnimationFrame(tick);
  }

  #finish(commit: boolean): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    this.#clearLongPress(session);
    if (session.autoScrollFrame !== null) {
      this.#window.cancelAnimationFrame(session.autoScrollFrame);
      session.autoScrollFrame = null;
    }
    this.#cancelSessionAnimations(session);
    const wasActive = session.active;
    const currentPosition = wasActive
      ? groupPosition(this.#currentBlocks(session), session.config.groupId)
      : { found: false, beforeGroupId: null };
    const shouldCommit = commit && wasActive && currentPosition.found;
    if (wasActive && !shouldCommit) this.#restoreOriginalOrder(session);
    else {
      this.#removeMarkers(session);
      if (wasActive) session.config.onLayoutChange?.();
    }

    session.preview?.layer.remove();
    session.preview = null;
    session.config.container.classList.remove("is-reordering", "is-drop-at-end");
    session.config.scrollHost?.classList.remove("is-reordering");
    (session.config.stateHost ?? this.#root).classList.remove("is-dragging");
    for (const element of session.allElements) {
      element.classList.remove("is-dragging", "is-drop-target");
    }
    try {
      const captureTarget = session.config.captureTarget;
      if (captureTarget?.hasPointerCapture(session.pointerId)) {
        captureTarget.releasePointerCapture(session.pointerId);
      }
    } catch {
      // A re-render may remove the capture target during final cleanup.
    }
    if (wasActive && !this.#disposed) this.#suppressNextClick(session);
    if (shouldCommit
      && currentPosition.beforeGroupId !== session.originalBeforeGroupId) {
      session.config.onCommit(currentPosition.beforeGroupId);
    }
  }

  #restoreOriginalOrder(session: PointerReorderSession): void {
    const before = rectMap(session.allElements);
    for (const element of session.allElements) {
      const marker = session.markers.get(element);
      if (marker?.parentNode === session.config.container) {
        session.config.container.insertBefore(element, marker);
      }
    }
    this.#removeMarkers(session);
    session.config.onLayoutChange?.();
    this.#animateFromRects(session.allElements, before);
  }

  #removeMarkers(session: PointerReorderSession): void {
    for (const marker of session.markers.values()) marker.remove();
    session.markers.clear();
  }

  #clearLongPress(session: PointerReorderSession): void {
    if (session.longPressTimer === null) return;
    this.#window.clearTimeout(session.longPressTimer);
    session.longPressTimer = null;
  }

  #suppressNextClick(session: PointerReorderSession): void {
    const lifetime = session.pointerType === "touch" ? 550 : 0;
    let timer = 0;
    let suppression: ClickSuppression;
    const listener: EventListener = (event) => {
      const target = event.target instanceof this.#window.Element ? event.target : null;
      if (!target || (!session.source.contains(target) && target !== session.downTarget)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppression.dispose();
    };
    const dispose = (): void => {
      this.#window.removeEventListener("click", listener, true);
      this.#window.clearTimeout(timer);
      this.#clickSuppressions.delete(suppression);
    };
    suppression = { dispose };
    this.#clickSuppressions.add(suppression);
    this.#window.addEventListener("click", listener, true);
    timer = this.#window.setTimeout(dispose, lifetime);
  }
}

function normalizeBlocks(config: PointerReorderConfig): NormalizedBlocks | null {
  if (!config.groupId || config.blocks.length < 2) return null;
  const groupIds = new Set<string>();
  const groupByElement = new Map<HTMLElement, string>();
  for (const block of config.blocks) {
    if (!block.groupId || groupIds.has(block.groupId) || block.elements.length === 0) return null;
    groupIds.add(block.groupId);
    for (const element of block.elements) {
      if (element.parentElement !== config.container || groupByElement.has(element)) return null;
      groupByElement.set(element, block.groupId);
    }
  }
  const blocks: MutableBlock[] = [];
  const elements: HTMLElement[] = [];
  for (const child of config.container.children) {
    if (!(child instanceof HTMLElement)) continue;
    const groupId = groupByElement.get(child);
    if (!groupId) continue;
    elements.push(child);
    const current = blocks[blocks.length - 1];
    if (current?.groupId === groupId) current.elements.push(child);
    else blocks.push({ groupId, elements: [child] });
  }
  if (blocks.length !== config.blocks.length || elements.length !== groupByElement.size) return null;
  if (new Set(blocks.map((block) => block.groupId)).size !== blocks.length) return null;
  return { blocks, elements, groupByElement };
}

function groupPosition(blocks: readonly MutableBlock[], groupId: string): GroupPosition {
  const index = blocks.findIndex((block) => block.groupId === groupId);
  return {
    found: index >= 0,
    beforeGroupId: index < 0 ? null : blocks[index + 1]?.groupId ?? null,
  };
}

function boundsOf(elements: readonly HTMLElement[]): DOMRect {
  const rects = elements.map((element) => element.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return DOMRect.fromRect({
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  });
}

function rectMap(elements: readonly HTMLElement[]): ReadonlyMap<HTMLElement, DOMRect> {
  return new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
}

function pointerDistance(session: PointerReorderSession, x: number, y: number): number {
  return Math.hypot(x - session.startX, y - session.startY);
}

function autoScrollVelocity(
  axis: PointerReorderAxis,
  rect: DOMRect,
  pointerX: number,
  pointerY: number,
): number {
  const horizontal = axis === "horizontal";
  const size = horizontal ? rect.width : rect.height;
  if (size <= 0) return 0;
  const start = horizontal ? rect.left : rect.top;
  const end = horizontal ? rect.right : rect.bottom;
  const pointer = horizontal ? pointerX : pointerY;
  const crossStart = horizontal ? rect.top : rect.left;
  const crossEnd = horizontal ? rect.bottom : rect.right;
  const crossPointer = horizontal ? pointerY : pointerX;
  if (crossPointer < crossStart - AUTO_SCROLL_CROSS_AXIS_MARGIN
    || crossPointer > crossEnd + AUTO_SCROLL_CROSS_AXIS_MARGIN) return 0;
  const zone = Math.min(AUTO_SCROLL_MAX_ZONE, size * AUTO_SCROLL_ZONE_RATIO);
  if (zone <= 0) return 0;
  if (pointer < start + zone) {
    const depth = clamp((start + zone - pointer) / zone, 0, 1);
    return -(AUTO_SCROLL_MIN_SPEED + depth * AUTO_SCROLL_SPEED_RANGE);
  }
  if (pointer > end - zone) {
    const depth = clamp((pointer - (end - zone)) / zone, 0, 1);
    return AUTO_SCROLL_MIN_SPEED + depth * AUTO_SCROLL_SPEED_RANGE;
  }
  return 0;
}

function sanitizePreviewClone<T extends HTMLElement>(clone: T): T {
  const elements = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (const element of elements) {
    element.removeAttribute("style");
    element.removeAttribute("id");
    element.removeAttribute("popover");
    element.classList.remove("is-dragging", "is-drop-target");
    if (element.matches("a, button, input, select, textarea, [contenteditable]")) {
      element.setAttribute("tabindex", "-1");
    }
  }
  clone.dataset.pointerReorderClone = "true";
  return clone;
}

function isIgnoredTarget(target: Element, source: HTMLElement): boolean {
  const ignored = target.closest(
    "input, textarea, select, a[href], [contenteditable]:not([contenteditable='false']), [data-pointer-reorder-ignore]",
  );
  return ignored !== null && source.contains(ignored);
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
