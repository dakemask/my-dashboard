import type { Home } from "@icon-park/svg";

export type TodoIconRenderer = typeof Home;

export function createTodoIcon(
  document: Document,
  renderer: TodoIconRenderer,
  size = 20,
): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderer({
    size,
    strokeWidth: 3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    theme: "outline",
    fill: "currentColor",
  }).replace(/^<\?xml[^>]*>\s*/u, "");
  const icon = template.content.querySelector("svg");
  if (!icon) throw new Error("IconPark did not return an SVG element.");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

