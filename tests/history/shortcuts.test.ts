// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installHistoryShortcuts,
  StagingHistory,
} from "../../src/shared/history";

describe("history shortcuts", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("uses Ctrl+Z and Ctrl+Y even while an input owns focus", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    const history = new StagingHistory({ value: "A" });
    history.commit({ value: "B" });
    const onProject = vi.fn();
    const dispose = installHistoryShortcuts(history, { onProject });

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
    expect(history.current).toEqual({ value: "A" });

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }),
    );
    expect(history.current).toEqual({ value: "B" });
    expect(onProject).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("does not treat Ctrl+Shift+Z as redo", () => {
    const history = new StagingHistory({ value: "A" });
    history.commit({ value: "B" });
    history.undo();
    const onProject = vi.fn();
    const dispose = installHistoryShortcuts(history, { onProject });

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    expect(history.current).toEqual({ value: "A" });
    expect(onProject).not.toHaveBeenCalled();
    dispose();
  });

  it("blocks native input history even when the module queue cannot move", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const history = new StagingHistory({ value: "A" });
    const dispose = installHistoryShortcuts(history);
    const event = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(history.current).toEqual({ value: "A" });
    dispose();
  });

  it("settles a module interaction before deciding whether history can move", () => {
    const history = new StagingHistory({ value: "A" });
    const beforeAction = vi.fn(() => history.commit({ value: "B" }));
    const onProject = vi.fn();
    const dispose = installHistoryShortcuts(history, { beforeAction, onProject });

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(beforeAction).toHaveBeenCalledWith("undo");
    expect(history.current).toEqual({ value: "A" });
    expect(onProject).toHaveBeenCalledWith({ value: "A" }, "undo");
    dispose();
  });
});
