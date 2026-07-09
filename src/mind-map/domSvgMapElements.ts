import { RESIZE_HANDLES, type Point, type ResizeHandle } from "./nodeFrame";
import type { ConnectorSide } from "./types";

export interface ArrowElements {
  group: SVGGElement;
  hitLine: SVGLineElement;
  line: SVGLineElement;
}

export interface NodeElementCallbacks {
  onConnectorClick: (event: MouseEvent, side: ConnectorSide) => void;
  onConnectorPointerDown: (event: PointerEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
  onResizePointerDown: (event: PointerEvent, handle: ResizeHandle) => void;
  onTextBlur: () => void;
  onTextContextMenu: (event: MouseEvent) => void;
  onTextFocus: () => void;
  onTextInput: () => void;
  onTextKeyDown: (event: KeyboardEvent) => void;
  onTextPaste: (event: ClipboardEvent) => void;
  onTextPointerDown: (event: PointerEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
}

export interface ArrowElementCallbacks {
  onContextMenu: (event: MouseEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function createMindMapNodeElement(
  id: string,
  connectorSides: ConnectorSide[],
  callbacks: NodeElementCallbacks,
): HTMLDivElement {
  const nodeElement = document.createElement("div");
  nodeElement.className = "mind-map-node";
  nodeElement.dataset.nodeId = id;
  nodeElement.tabIndex = -1;

  const textElement = document.createElement("div");
  textElement.className = "mind-map-node-text";
  setTextEditingEnabled(textElement, false);
  textElement.setAttribute("role", "textbox");
  textElement.setAttribute("aria-multiline", "true");
  textElement.spellcheck = false;

  textElement.addEventListener("pointerdown", callbacks.onTextPointerDown);
  textElement.addEventListener("focus", callbacks.onTextFocus);
  textElement.addEventListener("input", callbacks.onTextInput);
  textElement.addEventListener("paste", callbacks.onTextPaste);
  textElement.addEventListener("keydown", callbacks.onTextKeyDown);
  textElement.addEventListener("blur", callbacks.onTextBlur);
  textElement.addEventListener("contextmenu", callbacks.onTextContextMenu);

  nodeElement.addEventListener("contextmenu", callbacks.onContextMenu);
  nodeElement.append(textElement);

  for (const side of connectorSides) {
    const borderHit = document.createElement("div");

    borderHit.className = `mind-map-border-hit mind-map-border-hit-${side}`;
    borderHit.setAttribute("aria-hidden", "true");
    borderHit.addEventListener("pointerdown", callbacks.onPointerDown);
    nodeElement.append(borderHit);
  }

  for (const handle of RESIZE_HANDLES) {
    const handleElement = document.createElement("button");

    handleElement.type = "button";
    handleElement.className = `mind-map-handle mind-map-handle-${handle}`;
    handleElement.setAttribute("aria-label", `缩放 ${handle}`);
    handleElement.addEventListener("pointerdown", (event) => callbacks.onResizePointerDown(event, handle));
    nodeElement.append(handleElement);
  }

  for (const side of connectorSides) {
    const connector = document.createElement("button");

    connector.type = "button";
    connector.className = `mind-map-connector mind-map-connector-${side}`;
    connector.dataset.side = side;
    connector.setAttribute("aria-label", `${side} 连接点`);
    connector.addEventListener("pointerdown", callbacks.onConnectorPointerDown);
    connector.addEventListener("click", (event) => callbacks.onConnectorClick(event, side));
    nodeElement.append(connector);
  }

  return nodeElement;
}

export function createMindMapArrowMarker(markerId: string): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  const path = document.createElementNS(SVG_NS, "path");

  marker.id = markerId;
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "strokeWidth");
  path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  path.setAttribute("fill", "context-stroke");
  marker.append(path);
  defs.append(marker);

  return defs;
}

export function createMindMapArrowElements(
  id: string,
  markerId: string,
  callbacks: ArrowElementCallbacks,
): ArrowElements {
  const group = document.createElementNS(SVG_NS, "g");
  const hitLine = document.createElementNS(SVG_NS, "line");
  const line = document.createElementNS(SVG_NS, "line");

  group.classList.add("mind-map-arrow");
  group.dataset.arrowId = id;
  hitLine.classList.add("mind-map-arrow-hit");
  line.classList.add("mind-map-arrow-line");
  line.setAttribute("marker-end", `url(#${markerId})`);
  group.append(hitLine, line);
  group.addEventListener("pointerdown", callbacks.onPointerDown);
  group.addEventListener("contextmenu", callbacks.onContextMenu);

  return {
    group,
    hitLine,
    line,
  };
}

export function setLinePoints(line: SVGLineElement, from: Point, to: Point): void {
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
}

export function getEditableText(element: HTMLElement): string {
  return element.textContent ?? "";
}

export function setTextEditingEnabled(element: HTMLElement, enabled: boolean): void {
  element.setAttribute("contenteditable", enabled ? "plaintext-only" : "false");
  element.setAttribute("aria-readonly", String(!enabled));
}

export function insertPlainText(text: string): void {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return;
  }

  selection.deleteFromDocument();
  const range = selection.getRangeAt(0);
  const textNode = document.createTextNode(text);

  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  const range = document.createRange();

  range.selectNodeContents(element);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function releasePointerCapture(element: Element, pointerId: number): void {
  if (element.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
}
