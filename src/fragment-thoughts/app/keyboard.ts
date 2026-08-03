export type FragmentThoughtsKeyboardCommand = "undo" | "redo";

export function getFragmentThoughtsKeyboardCommand(
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "key"
    | "metaKey"
    | "shiftKey"
    | "target"
  >,
): FragmentThoughtsKeyboardCommand | null {
  if (
    event.defaultPrevented
    || event.isComposing
    || !event.ctrlKey
    || event.metaKey
    || event.altKey
    || event.shiftKey
    || isEditableEventTarget(event.target)
  ) {
    return null;
  }

  switch (event.key.toLowerCase()) {
    case "z":
      return "undo";
    case "y":
      return "redo";
    default:
      return null;
  }
}

/** Uses DOM shape instead of `instanceof`, so embedded/foreign realms work. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  let candidate: unknown = target;
  while (candidate && typeof candidate === "object") {
    const element = candidate as {
      readonly isContentEditable?: unknown;
      readonly tagName?: unknown;
      readonly parentElement?: unknown;
      readonly getAttribute?: (name: string) => string | null;
    };
    if (element.isContentEditable === true) return true;

    const tagName = typeof element.tagName === "string"
      ? element.tagName.toUpperCase()
      : "";
    if (
      tagName === "INPUT"
      || tagName === "TEXTAREA"
      || tagName === "SELECT"
    ) {
      return true;
    }

    if (typeof element.getAttribute === "function") {
      const contentEditable = element.getAttribute("contenteditable");
      if (contentEditable !== null) {
        return contentEditable.toLowerCase() !== "false";
      }
    }
    candidate = element.parentElement;
  }
  return false;
}
