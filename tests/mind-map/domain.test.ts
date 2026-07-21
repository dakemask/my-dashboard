import { describe, expect, it } from "vitest";
import {
  applyMindMapEvent,
  compareDisplayNames,
  comparableLibraryName,
  createEmptyMindMapPayload,
  invertMindMapEvent,
  normalizeFolderName,
  normalizeMapName,
  sameLibraryName,
  validateMindMapPayload,
  type MindMapDocument,
  type MindMapEvent,
  type MindMapPayload,
} from "../../src/mind-map/domain";
import { mindMapDefinition } from "../../src/mind-map/definition";
import { StagingHistory } from "../../src/shared/history";

function node(
  id: string,
  x: number,
  text = id,
) {
  return { id, text, x, y: 20, width: 260, height: 92, autoWidth: true } as const;
}

function fixture(): MindMapPayload {
  return validateMindMapPayload({
    folders: ["想法", "想法/工作"],
    maps: [{
      id: "map-1",
      path: "想法/工作/路线图",
      nodes: [node("node-2", 400), node("node-1", 10)],
      arrows: [{
        id: "arrow-1",
        from: { nodeId: "node-1", side: "right" },
        to: { nodeId: "node-2", side: "left" },
      }],
    }],
  });
}

function roundTrip(payload: MindMapPayload, event: MindMapEvent): MindMapPayload {
  const after = applyMindMapEvent(payload, event);
  return applyMindMapEvent(after, invertMindMapEvent(event, payload, after));
}

describe("Mind Map names and model", () => {
  it("normalizes user-entered names and compares siblings case-insensitively", () => {
    expect(normalizeFolderName(" 计划 ")).toBe("计划");
    expect(normalizeMapName(" 计划.JSON ")).toBe("计划");
    expect(normalizeMapName("计划.json.json")).toBe("计划");
    expect(normalizeMapName("e\u0301.json")).toBe("é");
    expect(sameLibraryName("Plan", "plan", "map")).toBe(true);
    expect(comparableLibraryName("Ｐlan", "map")).not.toBe(comparableLibraryName("Plan", "map"));
    expect(() => normalizeFolderName("results.json")).toThrow(/\.json/);
    expect(() => normalizeFolderName("a/b")).toThrow();
  });

  it("provides stable Chinese UI ordering", () => {
    const names = ["项目10", "项目2", "阿尔法"];
    names.sort(compareDisplayNames);
    expect(names.indexOf("项目2")).toBeLessThan(names.indexOf("项目10"));
  });

  it("strictly validates references, duplicates, paths and finite frames", () => {
    const payload = fixture();
    expect(payload.maps[0]?.nodes.map(({ id }) => id)).toEqual(["node-1", "node-2"]);
    expect(() => validateMindMapPayload({ ...payload, extra: true })).toThrow(/properties/);
    expect(() => validateMindMapPayload({
      ...payload,
      maps: [{ ...payload.maps[0]!, path: " 想法/工作/路线图" }],
    })).toThrow(/normalized/);
    expect(() => validateMindMapPayload({
      folders: ["Folder", "folder/Child"],
      maps: [],
    })).toThrow(/parent is missing/);
    expect(() => validateMindMapPayload({
      ...payload,
      maps: [{
        ...payload.maps[0]!,
        arrows: [{
          id: "bad",
          from: { nodeId: "missing", side: "right" },
          to: { nodeId: "node-2", side: "left" },
        }],
      }],
    })).toThrow(/missing node/);
    expect(() => validateMindMapPayload({
      ...payload,
      maps: [{
        ...payload.maps[0]!,
        nodes: [{ ...payload.maps[0]!.nodes[0]!, width: Number.NaN }],
        arrows: [],
      }],
    })).toThrow(/finite/);
    expect(() => applyMindMapEvent(payload, {
      type: "set-node-frame",
      mapId: "map-1",
      nodeId: "node-1",
      frame: { x: 0, y: 0, width: 10, height: 10, extra: true } as never,
      autoWidth: false,
    })).toThrow(/properties/);
    const normalizedZero = validateMindMapPayload({
      folders: [],
      maps: [{ id: "zero-map", path: "零", nodes: [node("zero-node", -0)], arrows: [] }],
    });
    expect(Object.is(normalizedZero.maps[0]!.nodes[0]!.x, -0)).toBe(false);
  });

  it("allows a folder and map to share a display name but not same-type siblings", () => {
    expect(() => validateMindMapPayload({
      folders: ["计划"],
      maps: [{ id: "map", path: "计划", nodes: [], arrows: [] }],
    })).not.toThrow();
    expect(() => validateMindMapPayload({
      folders: [],
      maps: [
        { id: "a", path: "Plan", nodes: [], arrows: [] },
        { id: "b", path: "plan", nodes: [], arrows: [] },
      ],
    })).toThrow(/Duplicate map path/);
  });
});

describe("Mind Map reversible events", () => {
  it("reverses folder creation, recursive deletion and relocation", () => {
    const payload = fixture();
    expect(roundTrip(payload, { type: "create-folder", path: "想法/空白" })).toEqual(payload);
    expect(roundTrip(payload, { type: "delete-folder", path: "想法/工作" })).toEqual(payload);
    const relocated = applyMindMapEvent(payload, {
      type: "relocate-folder",
      fromPath: "想法/工作",
      toPath: "想法/事业",
    });
    expect(relocated.maps[0]?.path).toBe("想法/事业/路线图");
    expect(roundTrip(payload, {
      type: "relocate-folder",
      fromPath: "想法/工作",
      toPath: "想法/事业",
    })).toEqual(payload);
    expect(() => applyMindMapEvent(payload, {
      type: "relocate-folder",
      fromPath: "想法",
      toPath: "想法/工作/内部",
    })).toThrow(/inside itself/);
  });

  it("does not treat a same-name map as the folder that contains it", () => {
    const payload = validateMindMapPayload({
      folders: ["A", "A/B"],
      maps: [
        { id: "root-sibling", path: "A", nodes: [], arrows: [] },
        { id: "nested-sibling", path: "A/B", nodes: [], arrows: [] },
        { id: "inside-nested", path: "A/B/C", nodes: [], arrows: [] },
      ],
    });

    const deletedNested = applyMindMapEvent(payload, { type: "delete-folder", path: "A/B" });
    expect(deletedNested.maps.map((map) => map.path)).toEqual(["A", "A/B"]);
    expect(roundTrip(payload, { type: "delete-folder", path: "A/B" })).toEqual(payload);

    const movedNested = applyMindMapEvent(payload, {
      type: "relocate-folder",
      fromPath: "A/B",
      toPath: "A/Z",
    });
    expect(movedNested.maps.map((map) => map.path)).toEqual(["A", "A/B", "A/Z/C"]);
    expect(roundTrip(payload, {
      type: "relocate-folder",
      fromPath: "A/B",
      toPath: "A/Z",
    })).toEqual(payload);

    const deletedRoot = applyMindMapEvent(payload, { type: "delete-folder", path: "A" });
    expect(deletedRoot.maps.map((map) => map.path)).toEqual(["A"]);
  });

  it("uses the canonical folder path when inverting a case-insensitive relocation", () => {
    const payload = validateMindMapPayload({ folders: ["Plan"], maps: [], });
    expect(roundTrip(payload, {
      type: "relocate-folder",
      fromPath: "plan",
      toPath: "Roadmap",
    })).toEqual(payload);
  });

  it("reverses map creation, deletion and relocation", () => {
    const payload = fixture();
    const map: MindMapDocument = { id: "map-2", path: "新图", nodes: [], arrows: [] };
    expect(roundTrip(payload, { type: "create-map", map })).toEqual(payload);
    expect(roundTrip(payload, { type: "delete-map", mapId: "map-1" })).toEqual(payload);
    expect(roundTrip(payload, {
      type: "relocate-map",
      mapId: "map-1",
      path: "想法/路线图",
    })).toEqual(payload);
  });

  it("commits text and its fitted frame as one reversible event", () => {
    const payload = fixture();
    const event: MindMapEvent = {
      type: "set-node-text",
      mapId: "map-1",
      nodeId: "node-1",
      text: "新的多行\n文字",
      frame: { x: 10, y: 20, width: 320, height: 118 },
      autoWidth: false,
    };
    const after = applyMindMapEvent(payload, event);
    expect(after.maps[0]?.nodes[0]).toMatchObject({
      text: "新的多行\n文字",
      width: 320,
      height: 118,
      autoWidth: false,
    });
    expect(roundTrip(payload, event)).toEqual(payload);
  });

  it("reverses add, frame, batch move and arrow events", () => {
    const payload = fixture();
    expect(roundTrip(payload, {
      type: "add-node",
      mapId: "map-1",
      node: node("node-3", 800),
    })).toEqual(payload);
    expect(roundTrip(payload, {
      type: "set-node-frame",
      mapId: "map-1",
      nodeId: "node-1",
      frame: { x: 1, y: 2, width: 300, height: 120 },
      autoWidth: false,
    })).toEqual(payload);
    expect(roundTrip(payload, {
      type: "move-nodes",
      mapId: "map-1",
      positions: [
        { nodeId: "node-1", x: 100, y: 200 },
        { nodeId: "node-2", x: 500, y: 600 },
      ],
    })).toEqual(payload);
    const withThird = applyMindMapEvent(payload, {
      type: "add-node",
      mapId: "map-1",
      node: node("node-3", 800),
    });
    expect(roundTrip(withThird, {
      type: "add-arrow",
      mapId: "map-1",
      arrow: {
        id: "arrow-2",
        from: { nodeId: "node-2", side: "right" },
        to: { nodeId: "node-3", side: "left" },
      },
    })).toEqual(withThird);
  });

  it("deletes selected and incident arrows in one event and restores exact content", () => {
    const payload = fixture();
    const event: MindMapEvent = {
      type: "delete-objects",
      mapId: "map-1",
      nodeIds: ["node-1"],
      arrowIds: [],
    };
    const after = applyMindMapEvent(payload, event);
    expect(after.maps[0]?.nodes.map(({ id }) => id)).toEqual(["node-2"]);
    expect(after.maps[0]?.arrows).toEqual([]);
    expect(roundTrip(payload, event)).toEqual(payload);
  });

  it("inverts restore-folder, restore-map and restore-objects when they are forward events", () => {
    const full = fixture();

    const withoutFolder = applyMindMapEvent(full, { type: "delete-folder", path: "想法/工作" });
    const restoreFolder = invertMindMapEvent(
      { type: "delete-folder", path: "想法/工作" },
      full,
      withoutFolder,
    );
    expect(restoreFolder.type).toBe("restore-folder");
    expect(roundTrip(withoutFolder, restoreFolder)).toEqual(withoutFolder);

    const withoutMap = applyMindMapEvent(full, { type: "delete-map", mapId: "map-1" });
    const restoreMap = invertMindMapEvent(
      { type: "delete-map", mapId: "map-1" },
      full,
      withoutMap,
    );
    expect(restoreMap.type).toBe("restore-map");
    expect(roundTrip(withoutMap, restoreMap)).toEqual(withoutMap);

    const deletion: MindMapEvent = {
      type: "delete-objects",
      mapId: "map-1",
      nodeIds: ["node-1"],
      arrowIds: [],
    };
    const withoutObjects = applyMindMapEvent(full, deletion);
    const restoreObjects = invertMindMapEvent(deletion, full, withoutObjects);
    expect(restoreObjects.type).toBe("restore-objects");
    expect(roundTrip(withoutObjects, restoreObjects)).toEqual(withoutObjects);
  });

  it("rejects a failed event atomically and keeps the source value untouched", () => {
    const payload = fixture();
    const original = structuredClone(payload);
    expect(() => applyMindMapEvent(payload, {
      type: "add-arrow",
      mapId: "map-1",
      arrow: {
        id: "bad",
        from: { nodeId: "node-1", side: "right" },
        to: { nodeId: "node-1", side: "left" },
      },
    })).toThrow(/itself/);
    expect(payload).toEqual(original);
  });
});

describe("Mind Map module definition", () => {
  it("uses the requested id, empty payload and 100-event capacity", () => {
    expect(mindMapDefinition.moduleId).toBe("mind-maps");
    expect(mindMapDefinition.createEmpty()).toEqual(createEmptyMindMapPayload());
    expect(mindMapDefinition.history.capacity).toBe(100);
  });

  it("retains 100 whole-library events and replaces a redo branch", () => {
    const history = new StagingHistory<MindMapPayload, MindMapEvent>(
      createEmptyMindMapPayload(),
      {
        contentKey: mindMapDefinition.contentKey,
        policy: mindMapDefinition.history,
      },
    );
    for (let index = 0; index < 101; index += 1) {
      history.dispatch({ type: "create-folder", path: `文件夹${index}` });
    }
    expect(history.size).toBe(100);

    history.undo();
    history.dispatch({ type: "create-folder", path: "新分支" });
    expect(history.canRedo).toBe(false);
    expect(history.current.folders).toContain("新分支");
    expect(history.current.folders).not.toContain("文件夹100");
  });

  it("undoes and redoes interleaved events from two maps in one global order", () => {
    const initial = validateMindMapPayload({
      folders: [],
      maps: [
        { id: "map-a", path: "甲", nodes: [node("node-a", 10, "甲-0")], arrows: [] },
        { id: "map-b", path: "乙", nodes: [node("node-b", 20, "乙-0")], arrows: [] },
      ],
    });
    const history = new StagingHistory<MindMapPayload, MindMapEvent>(initial, {
      contentKey: mindMapDefinition.contentKey,
      policy: mindMapDefinition.history,
    });
    const edit = (mapId: string, nodeId: string, text: string): MindMapEvent => ({
      type: "set-node-text",
      mapId,
      nodeId,
      text,
      frame: { x: mapId === "map-a" ? 10 : 20, y: 20, width: 260, height: 92 },
      autoWidth: true,
    });

    history.dispatch(edit("map-a", "node-a", "甲-1"));
    history.dispatch(edit("map-b", "node-b", "乙-1"));
    expect(history.current.maps.map((map) => map.nodes[0]!.text)).toEqual(["甲-1", "乙-1"]);

    history.undo();
    expect(history.current.maps.map((map) => map.nodes[0]!.text)).toEqual(["甲-1", "乙-0"]);
    history.undo();
    expect(history.current).toEqual(initial);
    history.redo();
    history.redo();
    expect(history.current.maps.map((map) => map.nodes[0]!.text)).toEqual(["甲-1", "乙-1"]);
  });
});
