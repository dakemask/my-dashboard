import Konva from "konva";
import type { NodeFrame } from "./types";

export interface TextEditSession {
  id: string;
  group: Konva.Group;
  textarea: HTMLTextAreaElement;
  textNode: Konva.Text | null;
  originalText: string;
  originalFrame: NodeFrame;
  autoWidthOnInput: boolean;
}

export interface EditTextPointerOptions {
  caretClientPoint?: {
    x: number;
    y: number;
  };
  dragSelect?: boolean;
}

export interface OpenTextEditorOptions extends EditTextPointerOptions {
  id: string;
  text: string;
  group: Konva.Group;
  textNode: Konva.Text | null;
  originalFrame: NodeFrame;
  autoWidthOnInput: boolean;
  selectAllWhenEmpty: boolean;
}

interface TextEditorOverlayCallbacks {
  onPreview: (session: TextEditSession) => void;
  onPosition: (session: TextEditSession) => void;
  onClose: (session: TextEditSession, commit: boolean) => void;
  getTextIndexAtClientPoint: (
    session: TextEditSession,
    clientPoint: {
      x: number;
      y: number;
    },
  ) => number;
}

interface ActiveTextEditSession extends TextEditSession {
  closed: boolean;
  removeListeners: () => void;
}

interface TextSelectionDrag {
  move: (event: MouseEvent) => void;
  up: (event: MouseEvent) => void;
}

export class TextEditorOverlay {
  private active: ActiveTextEditSession | null = null;
  private textSelectionDrag: TextSelectionDrag | null = null;
  private suppressEditorBlur = false;
  private suppressNextStageClick = false;

  constructor(private readonly callbacks: TextEditorOverlayCallbacks) {}

  get session(): TextEditSession | null {
    return this.active;
  }

  get activeId(): string | null {
    return this.active?.id ?? null;
  }

  open(options: OpenTextEditorOptions): void {
    if (this.active?.id === options.id) {
      this.focus(options);
      return;
    }

    this.close(true);

    const textarea = document.createElement("textarea");
    textarea.className = "node-text-editor";
    textarea.value = options.text;
    textarea.spellcheck = false;
    textarea.autocomplete = "off";
    textarea.autocapitalize = "off";
    document.body.append(textarea);

    let session: ActiveTextEditSession;
    const handleEditorMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      textarea.focus({
        preventScroll: true,
      });
      this.setSelectionFromClientPoint(session, {
        x: event.clientX,
        y: event.clientY,
      });
      this.startSelectionDrag(session, {
        x: event.clientX,
        y: event.clientY,
      });
    };
    const commitOnBlur = (): void => {
      if (this.textSelectionDrag || this.suppressEditorBlur) {
        requestAnimationFrame(() => {
          this.suppressEditorBlur = false;
          if (this.active !== session) {
            return;
          }

          textarea.focus({
            preventScroll: true,
          });
        });
        return;
      }

      this.close(true);
    };
    const previewInput = (): void => this.callbacks.onPreview(session);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close(true);
      }
    };

    session = {
      id: options.id,
      group: options.group,
      textarea,
      textNode: options.textNode,
      originalText: options.text,
      originalFrame: options.originalFrame,
      autoWidthOnInput: options.autoWidthOnInput,
      closed: false,
      removeListeners: () => {
        textarea.removeEventListener("blur", commitOnBlur);
        textarea.removeEventListener("input", previewInput);
        textarea.removeEventListener("mousedown", handleEditorMouseDown);
        textarea.removeEventListener("keydown", handleKeyDown);
      },
    };
    this.active = session;
    this.callbacks.onPosition(session);
    this.callbacks.onPreview(session);

    textarea.addEventListener("blur", commitOnBlur);
    textarea.addEventListener("input", previewInput);
    textarea.addEventListener("mousedown", handleEditorMouseDown);
    textarea.addEventListener("keydown", handleKeyDown);

    textarea.focus({
      preventScroll: true,
    });

    if (options.caretClientPoint) {
      this.focus(options);
      return;
    }

    requestAnimationFrame(() => {
      if (this.active !== session) {
        return;
      }

      textarea.focus({
        preventScroll: true,
      });
      if (options.selectAllWhenEmpty) {
        textarea.select();
      }
    });
  }

  focus(options: EditTextPointerOptions = {}): void {
    const session = this.active;

    if (!session) {
      return;
    }

    session.textarea.focus({
      preventScroll: true,
    });

    if (options.caretClientPoint) {
      this.setSelectionFromClientPoint(session, options.caretClientPoint);
    }

    if (options.dragSelect && options.caretClientPoint) {
      this.startSelectionDrag(session, options.caretClientPoint);
    }
  }

  close(commit: boolean): void {
    const session = this.active;

    if (!session || session.closed) {
      return;
    }

    session.closed = true;
    session.removeListeners();
    this.stopSelectionDrag();
    session.textarea.remove();
    this.active = null;
    this.suppressEditorBlur = false;
    this.callbacks.onClose(session, commit);
  }

  positionActive(): void {
    if (this.active) {
      this.callbacks.onPosition(this.active);
    }
  }

  consumeSuppressedStageClick(): boolean {
    if (!this.suppressNextStageClick) {
      return false;
    }

    this.suppressNextStageClick = false;
    return true;
  }

  private setSelectionFromClientPoint(
    session: TextEditSession,
    clientPoint: { x: number; y: number },
    anchorIndex?: number,
  ): void {
    const focusIndex = this.callbacks.getTextIndexAtClientPoint(session, clientPoint);
    const start = anchorIndex ?? focusIndex;
    const selectionStart = Math.min(start, focusIndex);
    const selectionEnd = Math.max(start, focusIndex);
    const direction = focusIndex < start ? "backward" : "forward";

    session.textarea.setSelectionRange(selectionStart, selectionEnd, direction);
  }

  private startSelectionDrag(session: TextEditSession, clientPoint: { x: number; y: number }): void {
    this.stopSelectionDrag();

    const anchorIndex = this.callbacks.getTextIndexAtClientPoint(session, clientPoint);
    this.setSelectionFromClientPoint(session, clientPoint, anchorIndex);

    const move = (event: MouseEvent): void => {
      event.preventDefault();
      if (this.active !== session) {
        this.stopSelectionDrag();
        return;
      }

      this.setSelectionFromClientPoint(
        session,
        {
          x: event.clientX,
          y: event.clientY,
        },
        anchorIndex,
      );
    };
    const up = (event: MouseEvent): void => {
      event.preventDefault();
      move(event);
      this.suppressEditorBlur = true;
      this.suppressNextStageClick = true;
      this.stopSelectionDrag();
      window.setTimeout(() => {
        this.suppressEditorBlur = false;
        this.suppressNextStageClick = false;
      }, 120);
    };

    this.textSelectionDrag = {
      move,
      up,
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, {
      once: true,
      capture: true,
    });
  }

  private stopSelectionDrag(): void {
    if (!this.textSelectionDrag) {
      return;
    }

    document.removeEventListener("mousemove", this.textSelectionDrag.move, true);
    document.removeEventListener("mouseup", this.textSelectionDrag.up, true);
    this.textSelectionDrag = null;
  }
}
