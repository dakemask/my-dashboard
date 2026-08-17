import { describe, expect, it } from "vitest";
import {
  computeDirtyLibraryState,
  findHistoryFocus,
} from "../../src/mind-maps/app/payloadDiff";
import type { MindMapDocument, MindMapPayload } from "../../src/mind-maps/domain";

const map = (id: string, path: string, text = ""): MindMapDocument => ({
  id,
  path,
  nodes: [{ id: `node-${id}`, text, x: 0, y: 0, width: 260, height: 92, autoWidth: false }],
  arrows: [],
});

describe("payload diff helpers", () => {
  it("marks a changed map and every visible ancestor folder dirty", () => {
    const baseline: MindMapPayload = {
      folders: ["工作", "工作/计划"],
      maps: [map("one", "工作/计划/季度")],
    };
    const current: MindMapPayload = {
      folders: baseline.folders,
      maps: [map("one", "工作/计划/季度", "更新")],
    };
    const dirty = computeDirtyLibraryState(current, baseline);
    expect([...dirty.mapIds]).toEqual(["one"]);
    expect([...dirty.folderPaths].sort()).toEqual(["工作", "工作/计划"]);
  });

  it("does not mark a same-path sibling folder dirty for a root map change", () => {
    const baseline: MindMapPayload = {
      folders: ["计划"],
      maps: [map("root", "计划")],
    };
    const current: MindMapPayload = {
      folders: baseline.folders,
      maps: [map("root", "计划", "更新")],
    };
    const dirty = computeDirtyLibraryState(current, baseline);
    expect([...dirty.mapIds]).toEqual(["root"]);
    expect([...dirty.folderPaths]).toEqual([]);
  });

  it("focuses the map changed by a cross-map history step", () => {
    const before: MindMapPayload = { folders: [], maps: [map("a", "A"), map("b", "B")] };
    const after: MindMapPayload = { folders: [], maps: [map("a", "A", "changed"), map("b", "B")] };
    expect(findHistoryFocus(before, after)).toEqual({
      selection: { kind: "map", mapId: "a" },
      mapIdToOpen: "a",
    });
  });

  it("selects a restored folder or the nearest surviving parent after deletion", () => {
    const before: MindMapPayload = {
      folders: ["父", "父/子"],
      maps: [map("a", "父/子/A")],
    };
    const deleted: MindMapPayload = { folders: ["父"], maps: [] };
    expect(findHistoryFocus(deleted, before)).toEqual({
      selection: { kind: "folder", path: "父/子" },
      mapIdToOpen: null,
    });
    expect(findHistoryFocus(before, deleted)).toEqual({
      selection: { kind: "folder", path: "父" },
      mapIdToOpen: null,
    });
  });
});
