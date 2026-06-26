import { DEFAULT_NODE_WIDTH, MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./mindMap";
import type { NodeFrame } from "./types";

export const TEXT_PADDING = 14;
export const TEXT_FONT_SIZE = 24;
export const TEXT_LINE_HEIGHT = 1.28;
export const TEXT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const EMPTY_TEXT_NATURAL_WIDTH = 80;
let measureContext: CanvasRenderingContext2D | null = null;

interface WrappedTextLayout {
  height: number;
  longestLineWidth: number;
}

export function fitNodeFrameToText(frame: NodeFrame, text: string): NodeFrame {
  const hasText = text.trim().length > 0;
  const requestedWidth = Math.max(MIN_NODE_WIDTH, Math.round(frame.width));
  const naturalWidth = hasText
    ? Math.ceil(measureNaturalTextWidth(text) + TEXT_PADDING * 2)
    : DEFAULT_NODE_WIDTH;
  let width = Math.min(requestedWidth, Math.max(MIN_NODE_WIDTH, naturalWidth));

  if (!hasText) {
    width = Math.min(width, DEFAULT_NODE_WIDTH);
  }

  const layout = measureWrappedText(text, width);
  if (hasText) {
    width = Math.max(MIN_NODE_WIDTH, Math.min(width, Math.ceil(layout.longestLineWidth + TEXT_PADDING * 2)));
  }

  const finalLayout = measureWrappedText(text, width);

  return {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width,
    height: Math.max(MIN_NODE_HEIGHT, Math.ceil(finalLayout.height + TEXT_PADDING * 2)),
  };
}

export function getCanvasTextFont(): string {
  return `400 ${TEXT_FONT_SIZE}px ${TEXT_FONT_FAMILY}`;
}

function measureNaturalTextWidth(text: string): number {
  const lines = normalizeText(text).split("\n");

  return Math.max(EMPTY_TEXT_NATURAL_WIDTH, ...lines.map(measureTextWidth));
}

function measureWrappedText(text: string, boxWidth: number): WrappedTextLayout {
  const maxTextWidth = Math.max(1, boxWidth - TEXT_PADDING * 2);
  const lines = normalizeText(text).split("\n").flatMap((line) => wrapLine(line, maxTextWidth));
  const lineHeight = TEXT_FONT_SIZE * TEXT_LINE_HEIGHT;

  return {
    height: Math.max(1, lines.length) * lineHeight,
    longestLineWidth: Math.max(0, ...lines.map(measureTextWidth)),
  };
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (!line) {
    return [""];
  }

  const wrapped: string[] = [];
  let current = "";

  Array.from(line).forEach((char) => {
    const next = `${current}${char}`;

    if (current && measureTextWidth(next) > maxWidth) {
      wrapped.push(current);
      current = char;
      return;
    }

    current = next;
  });

  wrapped.push(current);

  return wrapped;
}

function measureTextWidth(text: string): number {
  const context = getMeasureContext();
  context.font = getCanvasTextFont();

  return context.measureText(text).width;
}

function getMeasureContext(): CanvasRenderingContext2D {
  if (measureContext) {
    return measureContext;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  measureContext = context;
  return context;
}

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
