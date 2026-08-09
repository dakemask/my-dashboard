import type { MindMapNode, NodeFrame } from "../domain";
import type { CanvasTextChange } from "./types";

export interface CanvasEditingState {
  readonly nodeId: string;
  readonly originalText: string;
  readonly originalFrame: NodeFrame;
  readonly originalAutoWidth: boolean;
  currentFrame: NodeFrame;
  currentAutoWidth: boolean;
}

/** Owns the live text draft; DOM nodes remain a projection of this state. */
export class CanvasTextEditor {
  #state: CanvasEditingState | null = null;

  get state(): CanvasEditingState | null {
    return this.#state;
  }

  begin(node: MindMapNode, frame: NodeFrame): CanvasEditingState {
    this.#state = {
      nodeId: node.id,
      originalText: node.text,
      originalFrame: frame,
      originalAutoWidth: node.autoWidth,
      currentFrame: frame,
      currentAutoWidth: node.autoWidth,
    };
    return this.#state;
  }

  restore(state: CanvasEditingState): void {
    this.#state = state;
  }

  updateLayout(frame: NodeFrame, autoWidth: boolean): void {
    if (!this.#state) return;
    this.#state.currentFrame = frame;
    this.#state.currentAutoWidth = autoWidth;
  }

  hasPending(readText: (nodeId: string) => string | null): boolean {
    const state = this.#state;
    if (!state) return false;
    const text = readText(state.nodeId) ?? state.originalText;
    return (
      text !== state.originalText
      || !framesEqual(state.currentFrame, state.originalFrame)
      || state.currentAutoWidth !== state.originalAutoWidth
    );
  }

  take(readText: (nodeId: string) => string | null): CanvasTextChange | null {
    const state = this.#state;
    if (!state) return null;
    const text = readText(state.nodeId) ?? state.originalText;
    this.#state = null;
    return (
      text === state.originalText
      && framesEqual(state.currentFrame, state.originalFrame)
      && state.currentAutoWidth === state.originalAutoWidth
    ) ? null : {
      nodeId: state.nodeId,
      text,
      frame: state.currentFrame,
      autoWidth: state.currentAutoWidth,
    };
  }

  discard(): CanvasEditingState | null {
    const previous = this.#state;
    this.#state = null;
    return previous;
  }
}

export function framesEqual(left: NodeFrame, right: NodeFrame): boolean {
  return (
    left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  );
}
