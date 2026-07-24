import type { Search } from "@icon-park/svg";

export type MindMapIconRenderer = typeof Search;

export function createMindMapIcon(
  document: Document,
  renderer: MindMapIconRenderer,
  className?: string,
): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderer({
    size: 20,
    strokeWidth: 3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    theme: "outline",
    fill: "currentColor",
  }).replace(/^<\?xml[^>]*>\s*/u, "");
  const icon = template.content.querySelector("svg");
  if (!icon) throw new Error("IconPark did not return an SVG element.");
  icon.classList.add("mind-map-icon");
  if (className) icon.classList.add(className);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}
