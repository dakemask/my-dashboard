import { describe, expect, it } from "vitest";
import { planLibraryDelete } from "../../src/mind-maps/app/libraryCommands";
import {
  routePageKeyCommand,
  type PageKeyCommandInput,
} from "../../src/mind-maps/app/pageCommands";
import type { MindMapPayload } from "../../src/mind-maps/domain";

const baseKey = (overrides: Partial<PageKeyCommandInput>): PageKeyCommandInput => ({
  key: "",
  defaultPrevented: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  textEditing: false,
  withinLibrary: false,
  hasLibrarySelection: false,
  hasCanvasSelection: false,
  ...overrides,
});

describe("Mind Map page command router", () => {
  it("routes Delete to exactly one active context", () => {
    expect(routePageKeyCommand(baseKey({
      key: "Delete",
      withinLibrary: true,
      hasLibrarySelection: true,
      hasCanvasSelection: true,
    }))).toBe("delete-library");
    expect(routePageKeyCommand(baseKey({
      key: "Delete",
      hasCanvasSelection: true,
    }))).toBe("delete-canvas");
    expect(routePageKeyCommand(baseKey({
      key: "Delete",
      textEditing: true,
      hasCanvasSelection: true,
    }))).toBeNull();
  });

  it("keeps F2 and Escape unclaimed and blocks only documented redo shortcut", () => {
    expect(routePageKeyCommand(baseKey({ key: "F2", hasLibrarySelection: true }))).toBeNull();
    expect(routePageKeyCommand(baseKey({ key: "Escape", hasCanvasSelection: true }))).toBeNull();
    expect(routePageKeyCommand(baseKey({ key: "z", ctrlKey: true, shiftKey: true })))
      .toBe("suppress-redo-shortcut");
  });

  it("routes exact history and Alt creation commands even from text editing", () => {
    expect(routePageKeyCommand(baseKey({ key: "z", ctrlKey: true, textEditing: true })))
      .toBe("undo");
    expect(routePageKeyCommand(baseKey({ key: "y", ctrlKey: true, textEditing: true })))
      .toBe("redo");
    expect(routePageKeyCommand(baseKey({ key: "1", altKey: true, textEditing: true })))
      .toBe("add-node");
    expect(routePageKeyCommand(baseKey({ key: "2", altKey: true, textEditing: true })))
      .toBe("add-arrow");
  });
});

describe("Mind Map library command planning", () => {
  const payload: MindMapPayload = {
    folders: ["计划"],
    maps: [
      { id: "root-sibling", path: "计划", nodes: [], arrows: [] },
      { id: "inside", path: "计划/季度", nodes: [], arrows: [] },
    ],
  };

  it("does not close a same-path root map when deleting its sibling folder", () => {
    expect(planLibraryDelete(
      payload,
      { kind: "folder", path: "计划" },
      "root-sibling",
    ).closesCurrentMap).toBe(false);
    expect(planLibraryDelete(
      payload,
      { kind: "folder", path: "计划" },
      "inside",
    ).closesCurrentMap).toBe(true);
  });
});
