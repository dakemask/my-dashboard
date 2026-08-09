import {
  createIconParkIcon,
  type IconParkRenderer,
} from "../../shared";

export type TodoIconRenderer = IconParkRenderer;

export function createTodoIcon(
  document: Document,
  renderer: TodoIconRenderer,
  size = 20,
): SVGSVGElement {
  return createIconParkIcon(document, renderer, { size });
}

