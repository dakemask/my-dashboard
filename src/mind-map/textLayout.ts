import { DEFAULT_NODE_WIDTH, MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./mindMap";
import type { NodeFrame } from "./types";

export const TEXT_PADDING = 10;
export const TEXT_FONT_SIZE = 24;
export const TEXT_LINE_HEIGHT = 1.28;
export const TEXT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const EMPTY_TEXT_NATURAL_WIDTH = 80;
const TEXT_WRAP_TOLERANCE = 4;
let measureContext: CanvasRenderingContext2D | null = null;

interface WrappedTextLayout {
  height: number;
}

interface WrappedTextLine {
  text: string;
  start: number;
  end: number;
}

export function fitNodeFrameToText(frame: NodeFrame, text: string): NodeFrame {
  return fitNodeFrameHeightToText(frame, text);
}

export function fitNodeFrameHeightToText(frame: NodeFrame, text: string): NodeFrame {
  const width = Math.max(MIN_NODE_WIDTH, Math.round(frame.width));
  const layout = measureWrappedText(text, width);

  return {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width,
    height: Math.max(MIN_NODE_HEIGHT, Math.ceil(layout.height + TEXT_PADDING * 2)),
  };
}

export function fitNewNodeFrameToText(frame: NodeFrame, text: string): NodeFrame {
  const width = text.trim().length > 0 ? getNaturalNodeWidth(text) : DEFAULT_NODE_WIDTH;

  return fitNodeFrameHeightToText(
    {
      ...frame,
      width,
    },
    text,
  );
}

export function getCanvasTextFont(scale = 1): string {
  return `400 ${TEXT_FONT_SIZE * scale}px ${TEXT_FONT_FAMILY}`;
}

export function getTextIndexAtPoint(text: string, boxWidth: number, point: { x: number; y: number }): number {
  const lines = getWrappedTextLines(text, boxWidth);
  const lineHeight = TEXT_FONT_SIZE * TEXT_LINE_HEIGHT;
  const lineIndex = clamp(Math.floor(point.y / lineHeight), 0, lines.length - 1);
  const line = lines[lineIndex] ?? {
    text: "",
    start: 0,
    end: 0,
  };

  if (!line.text || point.x <= 0) {
    return line.start;
  }

  let index = line.start;
  let previousWidth = 0;
  let offset = 0;

  for (const char of Array.from(line.text)) {
    const nextOffset = offset + char.length;
    const nextWidth = measureTextWidth(line.text.slice(0, nextOffset));

    if (point.x < (previousWidth + nextWidth) / 2) {
      return index;
    }

    index += char.length;
    offset = nextOffset;
    previousWidth = nextWidth;
  }

  return line.end;
}

function getNaturalNodeWidth(text: string): number {
  return Math.max(
    MIN_NODE_WIDTH,
    Math.min(DEFAULT_NODE_WIDTH, Math.ceil(measureNaturalTextWidth(text) + TEXT_PADDING * 2)),
  );
}

function measureNaturalTextWidth(text: string): number {
  const lines = normalizeText(text).split("\n");

  return Math.max(EMPTY_TEXT_NATURAL_WIDTH, ...lines.map(measureTextWidth));
}

function measureWrappedText(text: string, boxWidth: number): WrappedTextLayout {
  const lines = getWrappedTextLines(text, boxWidth);
  const lineHeight = TEXT_FONT_SIZE * TEXT_LINE_HEIGHT;

  return {
    height: Math.max(1, lines.length) * lineHeight,
  };
}

function getWrappedTextLines(text: string, boxWidth: number): WrappedTextLine[] {
  const maxTextWidth = Math.max(1, boxWidth - TEXT_PADDING * 2);
  const lines = normalizeText(text).split("\n");
  const wrapped: WrappedTextLine[] = [];
  let start = 0;

  lines.forEach((line, index) => {
    wrapped.push(...wrapLine(line, start, maxTextWidth));
    start += line.length;

    if (index < lines.length - 1) {
      start += 1;
    }
  });

  return wrapped.length > 0
    ? wrapped
    : [
        {
          text: "",
          start: 0,
          end: 0,
        },
      ];
}

function wrapLine(line: string, start: number, maxWidth: number): WrappedTextLine[] {
  if (!line) {
    return [
      {
        text: "",
        start,
        end: start,
      },
    ];
  }

  const wrapped: WrappedTextLine[] = [];
  let current = "";
  let currentStart = start;
  let currentEnd = start;
  let index = start;

  for (const char of Array.from(line)) {
    const charStart = index;
    const charEnd = charStart + char.length;
    const next = `${current}${char}`;

    if (current && measureTextWidth(next) > maxWidth + TEXT_WRAP_TOLERANCE) {
      wrapped.push({
        text: current,
        start: currentStart,
        end: currentEnd,
      });
      current = char;
      currentStart = charStart;
      currentEnd = charEnd;
      index = charEnd;
      continue;
    }

    if (!current) {
      currentStart = charStart;
    }

    current = next;
    currentEnd = charEnd;
    index = charEnd;
  }

  wrapped.push({
    text: current,
    start: currentStart,
    end: currentEnd,
  });

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
