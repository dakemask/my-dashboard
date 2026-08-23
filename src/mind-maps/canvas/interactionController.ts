import type { MindMapBox, MindMapBracket, MindMapEndpoint, NodeFrame } from "../domain";
import { EdgeAutoPan, type AnimationFrameScheduler } from "./autoPan";
import type { FrameCorner, Point } from "./geometry";
import type { PointerCaptureAdapter } from "./types";
import type { CanvasViewport, ClientRectLike } from "./viewport";

export type MutableCanvasSelection = {
  nodeIds: Set<string>;
  boxIds: Set<string>;
  bracketIds: Set<string>;
  arrowIds: Set<string>;
};

export type BracketInteractionTarget = "from" | "body" | "to";
export type BoxInteractionTarget = "body" | FrameCorner;

interface PointerInteractionBase {
  readonly pointerId: number;
  lastClient: Point;
}

export type PointerInteraction =
  | { readonly kind: "idle" }
  | (PointerInteractionBase & {
      readonly kind: "marquee";
      readonly startWorld: Point;
      currentWorld: Point;
      readonly baseline: MutableCanvasSelection;
      readonly additive: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "moving";
      readonly startWorld: Point;
      readonly startClient: Point;
      currentWorld: Point;
      readonly nodeIds: readonly string[];
      readonly startFrames: ReadonlyMap<string, NodeFrame>;
      readonly toggleOnClickNodeId: string | null;
      moved: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "resizing";
      readonly nodeId: string;
      readonly startFrame: NodeFrame;
      readonly startClient: Point;
      currentFrame: NodeFrame;
      textPaintHeight: number;
      moved: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "adjusting-box";
      readonly boxId: string;
      readonly target: BoxInteractionTarget;
      readonly startBox: MindMapBox;
      readonly startWorld: Point;
      readonly startClient: Point;
      currentBox: MindMapBox;
      moved: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "adjusting-bracket";
      readonly bracketId: string;
      readonly target: BracketInteractionTarget;
      readonly startBracket: MindMapBracket;
      readonly startWorld: Point;
      readonly startClient: Point;
      currentBracket: MindMapBracket;
      moved: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "connecting";
      readonly from: MindMapEndpoint;
      currentWorld: Point;
      target: MindMapEndpoint | null;
    })
  | (PointerInteractionBase & {
      readonly kind: "panning";
      readonly startClient: Point;
      readonly startViewport: CanvasViewport;
    });

export type ActivePointerInteraction = Exclude<PointerInteraction, { kind: "idle" }>;

export interface CanvasInteractionControllerOptions {
  readonly svg: SVGSVGElement;
  readonly pointerCapture: PointerCaptureAdapter;
  readonly getBounds: () => ClientRectLike;
  readonly onAutoPan: (delta: Point) => void;
  readonly animationFrames?: AnimationFrameScheduler;
}

/** Centralizes pointer capture and auto-pan lifecycle for every canvas gesture. */
export class CanvasInteractionController {
  readonly #svg: SVGSVGElement;
  readonly #pointerCapture: PointerCaptureAdapter;
  readonly #autoPan: EdgeAutoPan;
  #current: PointerInteraction = { kind: "idle" };

  constructor(options: CanvasInteractionControllerOptions) {
    this.#svg = options.svg;
    this.#pointerCapture = options.pointerCapture;
    this.#autoPan = new EdgeAutoPan({
      getPointer: () => this.autoPanPointer,
      getBounds: options.getBounds,
      onPan: options.onAutoPan,
      scheduler: options.animationFrames,
    });
  }

  get current(): PointerInteraction {
    return this.#current;
  }

  get autoPanRunning(): boolean {
    return this.#autoPan.running;
  }

  get autoPanPointer(): Point | null {
    const interaction = this.#current;
    if (
      (
        interaction.kind === "resizing"
        || interaction.kind === "moving"
        || interaction.kind === "adjusting-box"
        || interaction.kind === "adjusting-bracket"
      )
      && !interaction.moved
    ) return null;
    return usesAutoPan(interaction) ? interaction.lastClient : null;
  }

  begin(interaction: ActivePointerInteraction): void {
    this.cancel();
    this.#current = interaction;
    this.#pointerCapture.capture(this.#svg, interaction.pointerId);
    if (usesAutoPan(interaction)) this.#autoPan.start();
  }

  update(pointerId: number, lastClient: Point): ActivePointerInteraction | null {
    const interaction = this.#current;
    if (interaction.kind === "idle" || interaction.pointerId !== pointerId) return null;
    interaction.lastClient = lastClient;
    return interaction;
  }

  finish(): ActivePointerInteraction | null {
    const interaction = this.#current;
    if (interaction.kind === "idle") return null;
    this.#autoPan.stop();
    this.#current = { kind: "idle" };
    this.#pointerCapture.release(this.#svg, interaction.pointerId);
    return interaction;
  }

  cancel(): ActivePointerInteraction | null {
    const interaction = this.#current;
    if (interaction.kind === "idle") return null;
    this.#autoPan.stop();
    this.#current = { kind: "idle" };
    this.#pointerCapture.release(this.#svg, interaction.pointerId);
    return interaction;
  }

  destroy(): void {
    this.cancel();
    this.#autoPan.destroy();
  }
}

export function usesAutoPan(
  interaction: PointerInteraction,
): interaction is Extract<
  PointerInteraction,
  {
    kind:
      | "marquee"
      | "moving"
      | "resizing"
      | "adjusting-box"
      | "adjusting-bracket"
      | "connecting";
  }
> {
  return (
    interaction.kind === "marquee"
    || interaction.kind === "moving"
    || interaction.kind === "resizing"
    || interaction.kind === "adjusting-box"
    || interaction.kind === "adjusting-bracket"
    || interaction.kind === "connecting"
  );
}
