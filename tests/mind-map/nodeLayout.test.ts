// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { MindMapNode } from "../../src/mind-map/domain";
import {
  BrowserTextMeasurement,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  finalizeNodeResize,
  fitNodeText,
  type CanvasTextMeasurement,
} from "../../src/mind-map/canvas";

describe("mind-map node layout", () => {
  it("uses measured natural width for the first non-empty default node edit", () => {
    const measurement = measurementWith(({ width }) => ({
      naturalWidth: 400,
      wrappedWidth: width,
      characterWidth: 10,
      height: width === DEFAULT_NODE_WIDTH ? 74 : 40,
      minimumWidth: 32,
      minimumHeight: 35,
    }));

    expect(fitNodeText("new", null, {
      originalText: "",
      originalFrame: { x: 5, y: 7, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
      originalAutoWidth: false,
    }, measurement)).toEqual({
      frame: { x: 5, y: 7, width: DEFAULT_NODE_WIDTH, height: 74 },
      autoWidth: false,
    });
  });

  it("settles wide and wrapped resizes from measured layout", () => {
    const node: MindMapNode = {
      id: "node",
      text: "content",
      x: 10,
      y: 20,
      width: 120,
      height: 60,
      autoWidth: false,
    };
    const wide = measurementWith(() => ({
      naturalWidth: 100,
      wrappedWidth: 100,
      characterWidth: 10,
      height: 52,
      minimumWidth: 32,
      minimumHeight: 35,
    }));
    expect(finalizeNodeResize(
      node,
      { x: 10, y: 20, width: 180, height: 2 },
      null,
      wide,
    )).toEqual({
      frame: { x: 10, y: 20, width: 100, height: 52 },
      autoWidth: true,
    });

    const wrapped = measurementWith(({ width }) => ({
      naturalWidth: 300,
      wrappedWidth: width === 100 ? 94 : width,
      characterWidth: 10,
      height: 76,
      minimumWidth: 32,
      minimumHeight: 35,
    }));
    expect(finalizeNodeResize(
      node,
      { x: 10, y: 20, width: 100, height: 2 },
      null,
      wrapped,
    )).toEqual({
      frame: { x: 10, y: 20, width: 94, height: 76 },
      autoWidth: false,
    });
  });

  it("measures browser text with the canvas font and wrapping width", () => {
    const measureText = vi.fn((text: string) => ({ width: [...text].length * 10 }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText,
    } as unknown as CanvasRenderingContext2D);
    const textarea = document.createElement("textarea");
    textarea.style.fontSize = "16px";
    textarea.style.lineHeight = "20px";

    const metrics = new BrowserTextMeasurement(document).measure({
      element: textarea,
      text: "abcd",
      width: 38,
    });

    expect(metrics.naturalWidth).toBe(58);
    expect(metrics.characterWidth).toBe(10);
    expect(metrics.height).toBe(54);
    expect(measureText).toHaveBeenCalled();
  });
});

function measurementWith(
  measure: CanvasTextMeasurement["measure"],
): CanvasTextMeasurement {
  return { measure };
}
