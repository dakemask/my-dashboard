import {
  DEFAULT_MINIMUM_NODE_HEIGHT,
  DEFAULT_MINIMUM_NODE_WIDTH,
  NODE_PADDING_X,
  NODE_PADDING_Y,
} from "./nodeLayout";
import type {
  CanvasTextMeasureInput,
  CanvasTextMeasurement,
  CanvasTextMetrics,
} from "./types";

export class BrowserTextMeasurement implements CanvasTextMeasurement {
  constructor(private readonly ownerDocument: Document) {}

  measure(input: CanvasTextMeasureInput): CanvasTextMetrics {
    const view = this.ownerDocument.defaultView;
    const style = input.element && view ? view.getComputedStyle(input.element) : null;
    const fontSize = finiteCssNumber(style?.fontSize, 15);
    const lineHeight = finiteCssNumber(style?.lineHeight, fontSize * 1.35);
    const measure = createTextWidthMeasure(this.ownerDocument, style?.font, fontSize);
    const logicalLines = input.text.length === 0 ? ["M"] : input.text.split("\n");
    const naturalContentWidth = Math.max(...logicalLines.map((line) => measure(line.length > 0 ? line : "M")));
    const characterWidth = Math.max(1, measure("字"));
    const minimumWidth = Math.max(DEFAULT_MINIMUM_NODE_WIDTH, Math.ceil(characterWidth + NODE_PADDING_X));
    const minimumHeight = Math.max(DEFAULT_MINIMUM_NODE_HEIGHT, Math.ceil(lineHeight + NODE_PADDING_Y));
    const availableContentWidth = Math.max(1, input.width - NODE_PADDING_X);
    let visualLineCount = 0;
    let maximumVisualLineWidth = 0;

    for (const logicalLine of logicalLines) {
      if (logicalLine.length === 0) {
        visualLineCount += 1;
        continue;
      }
      let lineWidth = 0;
      let lines = 1;
      for (const character of logicalLine) {
        const width = Math.max(1, measure(character));
        if (lineWidth > 0 && lineWidth + width > availableContentWidth) {
          maximumVisualLineWidth = Math.max(maximumVisualLineWidth, lineWidth);
          lines += 1;
          lineWidth = width;
        } else {
          lineWidth += width;
        }
      }
      maximumVisualLineWidth = Math.max(maximumVisualLineWidth, lineWidth);
      visualLineCount += lines;
    }

    return {
      naturalWidth: Math.max(minimumWidth, Math.ceil(naturalContentWidth + NODE_PADDING_X)),
      wrappedWidth: Math.max(minimumWidth, Math.ceil(maximumVisualLineWidth + NODE_PADDING_X)),
      characterWidth,
      height: Math.max(minimumHeight, Math.ceil(visualLineCount * lineHeight + NODE_PADDING_Y)),
      minimumWidth,
      minimumHeight,
    };
  }
}

function createTextWidthMeasure(
  ownerDocument: Document,
  font: string | undefined,
  fontSize: number,
): (text: string) => number {
  try {
    const context = ownerDocument.createElement("canvas").getContext("2d");
    if (context) {
      if (font) context.font = font;
      return (text) => context.measureText(text).width;
    }
  } catch {
    // jsdom and restricted browsers can lack a canvas text implementation.
  }
  return (text) => [...text].length * fontSize * 0.8;
}

function finiteCssNumber(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
