import { describe, expect, it } from "vitest";
import {
  getFragmentThoughtsKeyboardCommand,
  isEditableEventTarget,
} from "../../src/fragment-thoughts/app/keyboard";

function event(
  overrides: Partial<Parameters<typeof getFragmentThoughtsKeyboardCommand>[0]> = {},
): Parameters<typeof getFragmentThoughtsKeyboardCommand>[0] {
  return {
    altKey: false,
    ctrlKey: true,
    defaultPrevented: false,
    isComposing: false,
    key: "z",
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

describe("Fragment Thoughts keyboard commands", () => {
  it("recognizes only the documented Ctrl+Z and Ctrl+Y commands", () => {
    expect(getFragmentThoughtsKeyboardCommand(event())).toBe("undo");
    expect(getFragmentThoughtsKeyboardCommand(event({ key: "Y" }))).toBe("redo");
    expect(getFragmentThoughtsKeyboardCommand(event({ key: "x" }))).toBeNull();
    expect(getFragmentThoughtsKeyboardCommand(event({ ctrlKey: false }))).toBeNull();
    expect(getFragmentThoughtsKeyboardCommand(event({ shiftKey: true }))).toBeNull();
  });

  it("leaves composing and native editable undo untouched", () => {
    expect(getFragmentThoughtsKeyboardCommand(event({ isComposing: true }))).toBeNull();
    expect(getFragmentThoughtsKeyboardCommand(event({
      target: { tagName: "textarea" } as unknown as EventTarget,
    }))).toBeNull();
  });

  it("detects editable targets without realm-sensitive instanceof checks", () => {
    const editableParent = {
      tagName: "DIV",
      isContentEditable: true,
      parentElement: null,
    };
    const child = {
      tagName: "SPAN",
      parentElement: editableParent,
    };
    expect(isEditableEventTarget(child as unknown as EventTarget)).toBe(true);
    expect(isEditableEventTarget({
      tagName: "SELECT",
      parentElement: null,
    } as unknown as EventTarget)).toBe(true);
    expect(isEditableEventTarget({
      tagName: "BUTTON",
      parentElement: null,
    } as unknown as EventTarget)).toBe(false);
    expect(isEditableEventTarget({
      tagName: "SPAN",
      parentElement: {
        tagName: "DIV",
        getAttribute: (name: string) => name === "contenteditable" ? "false" : null,
        parentElement: editableParent,
      },
    } as unknown as EventTarget)).toBe(false);
  });
});
