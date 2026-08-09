import {
  createIconParkIcon,
  type IconParkRenderer,
} from "../../shared";

/** @deprecated Prefer the Shared root icon helpers for new UI. */
export type MindMapIconRenderer = IconParkRenderer;

export function createMindMapIcon(
  document: Document,
  renderer: MindMapIconRenderer,
  className?: string,
): SVGSVGElement {
  return createIconParkIcon(document, renderer, {
    classNames: className ? ["mind-map-icon", className] : "mind-map-icon",
  });
}
