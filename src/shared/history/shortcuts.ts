import type { StagingHistory } from "./StagingHistory";

export interface HistoryShortcutOptions<T> {
  readonly target?: Pick<Document, "addEventListener" | "removeEventListener">;
  readonly beforeAction?: (action: "undo" | "redo") => void;
  readonly onProject?: (payload: T, action: "undo" | "redo") => void;
}

/** Installs the deliberately small shared shortcut set: Ctrl+Z and Ctrl+Y. */
export function installHistoryShortcuts<T>(
  history: StagingHistory<T>,
  options: HistoryShortcutOptions<T> = {},
): () => void {
  const target = options.target ?? document;
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") {
      return;
    }

    event.preventDefault();
    const action = key === "z" ? "undo" : "redo";
    options.beforeAction?.(action);

    if (action === "undo" && history.canUndo) {
      options.onProject?.(history.undo(), "undo");
    } else if (action === "redo" && history.canRedo) {
      options.onProject?.(history.redo(), "redo");
    }
  };

  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
