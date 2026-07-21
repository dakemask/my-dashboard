import type { Point } from "./geometry";
import type { ClientRectLike } from "./viewport";

export interface EdgePanOptions {
  readonly edgeSize?: number;
  readonly maximumSpeed?: number;
}

export interface AnimationFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface EdgeAutoPanOptions extends EdgePanOptions {
  readonly getPointer: () => Point | null;
  readonly getBounds: () => ClientRectLike;
  readonly onPan: (viewportDelta: Point) => void;
  readonly scheduler?: AnimationFrameScheduler;
}

const DEFAULT_EDGE_SIZE = 56;
const DEFAULT_MAXIMUM_SPEED = 720;
const DEFAULT_FRAME_SECONDS = 1 / 60;
const MAX_FRAME_SECONDS = 0.05;

/**
 * Returns viewport-offset pixels per second. Near the right edge x is negative,
 * moving the world left and revealing content to the right.
 */
export function edgePanVelocity(
  pointer: Point,
  bounds: ClientRectLike,
  options: EdgePanOptions = {},
): Point {
  const edgeSize = Math.max(1, options.edgeSize ?? DEFAULT_EDGE_SIZE);
  const maximumSpeed = Math.max(0, options.maximumSpeed ?? DEFAULT_MAXIMUM_SPEED);
  return {
    x: axisVelocity(pointer.x, bounds.left, bounds.left + bounds.width, edgeSize, maximumSpeed),
    y: axisVelocity(pointer.y, bounds.top, bounds.top + bounds.height, edgeSize, maximumSpeed),
  };
}

export class EdgeAutoPan {
  readonly #getPointer: () => Point | null;
  readonly #getBounds: () => ClientRectLike;
  readonly #onPan: (viewportDelta: Point) => void;
  readonly #scheduler: AnimationFrameScheduler;
  readonly #velocityOptions: EdgePanOptions;
  #frameHandle: number | null = null;
  #lastTimestamp: number | null = null;

  constructor(options: EdgeAutoPanOptions) {
    this.#getPointer = options.getPointer;
    this.#getBounds = options.getBounds;
    this.#onPan = options.onPan;
    this.#velocityOptions = {
      edgeSize: options.edgeSize,
      maximumSpeed: options.maximumSpeed,
    };
    this.#scheduler = options.scheduler ?? browserScheduler();
  }

  get running(): boolean {
    return this.#frameHandle !== null;
  }

  start(): void {
    if (this.#frameHandle !== null) return;
    this.#lastTimestamp = null;
    this.#frameHandle = this.#scheduler.request(this.#tick);
  }

  stop(): void {
    if (this.#frameHandle !== null) this.#scheduler.cancel(this.#frameHandle);
    this.#frameHandle = null;
    this.#lastTimestamp = null;
  }

  destroy(): void {
    this.stop();
  }

  readonly #tick = (timestamp: number): void => {
    this.#frameHandle = null;
    const pointer = this.#getPointer();
    if (!pointer) {
      this.#lastTimestamp = timestamp;
      this.#frameHandle = this.#scheduler.request(this.#tick);
      return;
    }

    const velocity = edgePanVelocity(pointer, this.#getBounds(), this.#velocityOptions);
    const elapsed = this.#lastTimestamp === null
      ? DEFAULT_FRAME_SECONDS
      : Math.min(MAX_FRAME_SECONDS, Math.max(0, (timestamp - this.#lastTimestamp) / 1000));
    this.#lastTimestamp = timestamp;
    if (velocity.x !== 0 || velocity.y !== 0) {
      this.#onPan({ x: velocity.x * elapsed, y: velocity.y * elapsed });
    }
    this.#frameHandle = this.#scheduler.request(this.#tick);
  };
}

function axisVelocity(
  position: number,
  minimum: number,
  maximum: number,
  edgeSize: number,
  maximumSpeed: number,
): number {
  if (position < minimum + edgeSize) {
    return maximumSpeed * Math.min(1, Math.max(0, (minimum + edgeSize - position) / edgeSize));
  }
  if (position > maximum - edgeSize) {
    return -maximumSpeed * Math.min(1, Math.max(0, (position - (maximum - edgeSize)) / edgeSize));
  }
  return 0;
}

function browserScheduler(): AnimationFrameScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}

