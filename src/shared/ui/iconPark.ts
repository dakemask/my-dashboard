import type { Home } from "@icon-park/svg";

export type IconParkRenderer = typeof Home;
export type IconParkClassNames = string | readonly string[];

export interface IconParkIconOptions {
  readonly size?: number | string;
  readonly strokeWidth?: number;
  readonly classNames?: IconParkClassNames;
  /** Set only when the SVG itself carries meaning; button icons stay decorative. */
  readonly ariaLabel?: string;
}

export interface IconOnlyButtonOptions {
  readonly classNames?: IconParkClassNames;
  readonly iconClassNames?: IconParkClassNames;
  readonly iconSize?: number | string;
  readonly strokeWidth?: number;
}

export function createIconParkIcon(
  document: Document,
  renderer: IconParkRenderer,
  options: IconParkIconOptions = {},
): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderer({
    size: options.size ?? 20,
    strokeWidth: options.strokeWidth ?? 3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    theme: "outline",
    fill: "currentColor",
  }).replace(/^<\?xml[^>]*>\s*/u, "");
  const icon = template.content.querySelector("svg");
  if (!icon) throw new Error("IconPark did not return an SVG element.");

  addClassNames(icon, options.classNames);
  icon.setAttribute("focusable", "false");
  if (options.ariaLabel) {
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", options.ariaLabel);
    icon.removeAttribute("aria-hidden");
  } else {
    icon.setAttribute("aria-hidden", "true");
    icon.removeAttribute("aria-label");
    icon.removeAttribute("role");
  }
  return icon;
}

export function createIconOnlyButton(
  document: Document,
  renderer: IconParkRenderer,
  label: string,
  options: IconOnlyButtonOptions = {},
): HTMLButtonElement {
  const accessibleLabel = label.trim();
  if (!accessibleLabel) {
    throw new TypeError("An icon-only button requires a non-empty label.");
  }

  const button = document.createElement("button");
  button.type = "button";
  button.title = accessibleLabel;
  button.setAttribute("aria-label", accessibleLabel);
  addClassNames(button, options.classNames);
  button.append(createIconParkIcon(document, renderer, {
    size: options.iconSize,
    strokeWidth: options.strokeWidth,
    classNames: options.iconClassNames,
  }));
  return button;
}

function addClassNames(element: Element, classNames?: IconParkClassNames): void {
  if (!classNames) return;
  const values = typeof classNames === "string" ? [classNames] : classNames;
  for (const value of values) {
    for (const className of value.split(/\s+/u)) {
      if (className) element.classList.add(className);
    }
  }
}
