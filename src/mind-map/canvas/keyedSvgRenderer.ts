export interface KeyedSvgRendererOptions<TItem, TElement extends Element> {
  readonly key: (item: TItem) => string;
  readonly create: (item: TItem) => TElement;
  readonly update: (element: TElement, item: TItem) => void;
}

/** Reconciles an SVG layer by stable business id without replacing existing descendants. */
export class KeyedSvgRenderer<TItem, TElement extends Element> {
  readonly #container: Element;
  readonly #options: KeyedSvgRendererOptions<TItem, TElement>;
  readonly #elements = new Map<string, TElement>();

  constructor(container: Element, options: KeyedSvgRendererOptions<TItem, TElement>) {
    this.#container = container;
    this.#options = options;
  }

  get(key: string): TElement | null {
    return this.#elements.get(key) ?? null;
  }

  render(items: readonly TItem[]): void {
    const remaining = new Set(this.#elements.keys());
    let previous: Element | null = null;
    for (const item of items) {
      const key = this.#options.key(item);
      let element = this.#elements.get(key);
      if (!element) {
        element = this.#options.create(item);
        this.#elements.set(key, element);
      }
      remaining.delete(key);
      this.#options.update(element, item);
      const desiredPrevious = element.previousElementSibling;
      if (element.parentElement !== this.#container || desiredPrevious !== previous) {
        this.#container.insertBefore(element, previous?.nextSibling ?? this.#container.firstChild);
      }
      previous = element;
    }
    for (const key of remaining) {
      this.#elements.get(key)?.remove();
      this.#elements.delete(key);
    }
  }

  reorder(keys: readonly string[]): void {
    let previous: Element | null = null;
    for (const key of keys) {
      const element = this.#elements.get(key);
      if (!element) continue;
      if (element.parentElement !== this.#container || element.previousElementSibling !== previous) {
        this.#container.insertBefore(element, previous?.nextSibling ?? this.#container.firstChild);
      }
      previous = element;
    }
  }

  clear(): void {
    for (const element of this.#elements.values()) element.remove();
    this.#elements.clear();
  }
}
