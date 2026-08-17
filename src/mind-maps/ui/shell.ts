import { MindMapFeedback } from "./feedback";
import { MindMapPageView } from "./pageView";
import type {
  DialogChoice,
  MindMapMessageTone,
  MindMapShellElements,
} from "./types";

export type { DialogChoice, MindMapShellElements } from "./types";

/** Stable compatibility facade used by MindMapController. */
export class MindMapShell {
  readonly elements: MindMapShellElements;
  readonly #page: MindMapPageView;
  readonly #feedback: MindMapFeedback;

  constructor(appRoot: HTMLElement) {
    this.#page = new MindMapPageView(appRoot);
    this.#feedback = new MindMapFeedback(this.#page.elements.root);
    this.elements = { ...this.#page.elements, toast: this.#feedback.toast };
  }

  get dialogOpen(): boolean {
    return this.#feedback.dialogOpen;
  }

  setSidebarOpen(open: boolean): void {
    this.#page.setSidebarOpen(open);
  }

  setMapTitle(title: string | null, dirty: boolean): void {
    this.#page.setMapTitle(title, dirty);
  }

  setLibrarySelectionAvailable(available: boolean): void {
    this.#page.setLibrarySelectionAvailable(available);
  }

  setArrowMode(active: boolean): void {
    this.#page.setArrowMode(active);
  }

  setSaveRetryVisible(visible: boolean): void {
    this.#page.setSaveRetryVisible(visible);
  }

  showMessage(message: string, tone: MindMapMessageTone = "normal"): void {
    this.#feedback.showMessage(message, tone);
  }

  choose(title: string, message: string, choices: readonly DialogChoice[]): Promise<string> {
    return this.#feedback.choose(title, message, choices);
  }

  dispose(): void {
    this.#feedback.dispose();
  }
}
