import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./mindMap";
import { clamp, resizeChangesWidth, type ResizeHandle } from "./nodeFrame";
import type { MindMapNode, NodeFrame } from "./types";

export interface TextEditSnapshot {
  autoWidth: boolean;
  originalFrame: NodeFrame;
  originalText: string;
}

export interface CommittedDragFrameInput {
  kind: "move" | "resize";
  frame: NodeFrame;
  handle?: ResizeHandle;
  textElement: HTMLElement | null;
  node: MindMapNode | null;
}

interface NodeSize {
  width: number;
  height: number;
}

// Nodes use border-box sizing; the text area loses 8px on each side plus the 1px border on each side.
const NODE_PADDING_X = 18;
const NODE_PADDING_Y = 14;

export class TextBoxLayout {
  constructor(private readonly host: HTMLElement) {}

  getTextFittedFrame(
    textElement: HTMLElement,
    text: string,
    baseFrame: NodeFrame,
    edit: TextEditSnapshot,
  ): NodeFrame {
    const minimumSize = this.measureMinimumNodeSize(textElement);
    const naturalWidth = this.measureTextMaxLineWidth(textElement, text);
    const shouldFitInitialWidth =
      edit.originalText.length === 0 &&
      edit.originalFrame.width === DEFAULT_NODE_WIDTH &&
      edit.originalFrame.height === DEFAULT_NODE_HEIGHT &&
      text.length > 0;
    const width = edit.autoWidth
      ? naturalWidth
      : shouldFitInitialWidth
        ? clamp(naturalWidth, minimumSize.width, DEFAULT_NODE_WIDTH)
        : Math.max(minimumSize.width, Math.round(baseFrame.width));
    const height = Math.max(minimumSize.height, this.measureTextHeight(textElement, text, width));

    return {
      x: Math.round(baseFrame.x),
      y: Math.round(baseFrame.y),
      width,
      height,
    };
  }

  getCommittedDragFrame(input: CommittedDragFrameInput): NodeFrame {
    const { kind, frame, handle, textElement, node } = input;
    const fixedRight = frame.x + frame.width;
    const fixedBottom = frame.y + frame.height;
    const minimumSize = textElement
      ? this.measureMinimumNodeSize(textElement)
      : {
          width: MIN_NODE_WIDTH,
          height: MIN_NODE_HEIGHT,
        };
    let width = Math.max(minimumSize.width, Math.round(frame.width));
    let autoWidth = node?.autoWidth ?? false;

    if (kind === "resize" && textElement) {
      const text = getEditableText(textElement);
      const naturalWidth = this.measureTextMaxLineWidth(textElement, text);

      if (resizeChangesWidth(handle)) {
        if (width > naturalWidth) {
          width = naturalWidth;
          autoWidth = true;
        } else {
          autoWidth = false;
        }
      } else if (autoWidth) {
        width = naturalWidth;
      }

      width = this.tightenSubCharacterWidthRemainder(textElement, text, width, minimumSize.width);
    }

    const height =
      kind === "resize" && textElement
        ? Math.max(minimumSize.height, this.measureTextHeight(textElement, getEditableText(textElement), width))
        : Math.max(minimumSize.height, Math.round(frame.height));
    const nextFrame: NodeFrame = {
      x: Math.round(handle?.includes("w") ? fixedRight - width : frame.x),
      y: Math.round(handle?.includes("n") ? fixedBottom - height : frame.y),
      width,
      height,
    };

    if (kind === "resize") {
      nextFrame.autoWidth = autoWidth;
    }

    return nextFrame;
  }

  private measureTextMaxLineWidth(textElement: HTMLElement, text: string): number {
    const minimumSize = this.measureMinimumNodeSize(textElement);

    return Math.max(minimumSize.width, this.measureNaturalTextWidth(textElement, text));
  }

  private tightenSubCharacterWidthRemainder(
    textElement: HTMLElement,
    text: string,
    width: number,
    minimumWidth: number,
  ): number {
    const fittedWidth = this.measureWrappedTextMaxLineWidth(textElement, text, width);
    const remainingWidth = width - fittedWidth;
    const characterWidth = Math.max(1, this.measureNaturalTextWidth(textElement, "字") - NODE_PADDING_X);

    if (remainingWidth > 0 && remainingWidth < characterWidth) {
      return Math.max(minimumWidth, fittedWidth);
    }

    return width;
  }

  private measureMinimumNodeSize(textElement: HTMLElement): NodeSize {
    const width = Math.max(MIN_NODE_WIDTH, this.measureNaturalTextWidth(textElement, "字"));
    const height = Math.max(MIN_NODE_HEIGHT, this.measureTextHeight(textElement, "字", width));

    return {
      width,
      height,
    };
  }

  private measureNaturalTextWidth(textElement: HTMLElement, text: string): number {
    const clone = this.createTextMeasureElement(textElement, text.length > 0 ? text : "M");

    clone.style.display = "inline-block";
    clone.style.whiteSpace = "pre";
    clone.style.width = "auto";
    clone.style.maxWidth = "none";
    this.host.append(clone);

    const width = Math.ceil(clone.getBoundingClientRect().width + NODE_PADDING_X);

    clone.remove();
    return width;
  }

  private measureWrappedTextMaxLineWidth(textElement: HTMLElement, text: string, width: number): number {
    const clone = this.createTextMeasureElement(textElement, text.length > 0 ? text : "M");

    clone.style.width = `${Math.max(1, width - NODE_PADDING_X)}px`;
    clone.style.whiteSpace = "pre-wrap";
    this.host.append(clone);

    const range = document.createRange();
    range.selectNodeContents(clone);

    let maxLineWidth = 0;

    for (const rect of range.getClientRects()) {
      maxLineWidth = Math.max(maxLineWidth, rect.width);
    }

    range.detach();
    clone.remove();

    return Math.ceil(maxLineWidth + NODE_PADDING_X);
  }

  private measureTextHeight(textElement: HTMLElement, text: string, width: number): number {
    const clone = this.createTextMeasureElement(textElement, text.length > 0 ? text : "M");

    clone.style.width = `${Math.max(1, width - NODE_PADDING_X)}px`;
    clone.style.whiteSpace = "pre-wrap";
    this.host.append(clone);

    const height = Math.ceil(clone.scrollHeight + NODE_PADDING_Y);

    clone.remove();
    return height;
  }

  private createTextMeasureElement(source: HTMLElement, text: string): HTMLDivElement {
    const style = getComputedStyle(source);
    const clone = document.createElement("div");

    clone.className = "mind-map-text-measure";
    clone.textContent = text;
    clone.style.font = style.font;
    clone.style.lineHeight = style.lineHeight;
    clone.style.letterSpacing = style.letterSpacing;
    clone.style.overflowWrap = style.overflowWrap;
    clone.style.wordBreak = style.wordBreak;

    return clone;
  }
}

function getEditableText(element: HTMLElement): string {
  return element.textContent ?? "";
}
