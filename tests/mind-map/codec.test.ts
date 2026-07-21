import { describe, expect, it } from "vitest";
import {
  decodeMindMapPayload,
  encodeMindMapPayload,
  validateMindMapPayload,
} from "../../src/mind-map/domain";

describe("Mind Map remote codec", () => {
  const payload = validateMindMapPayload({
    folders: ["资料", "资料/空文件夹", "资料/项目"],
    maps: [{
      id: "map-1",
      path: "资料/项目/规划",
      nodes: [
        { id: "b", text: "B", x: 20, y: 0, width: 260, height: 92, autoWidth: true },
        { id: "a", text: "A", x: 0, y: 0, width: 260, height: 92, autoWidth: true },
      ],
      arrows: [{
        id: "arrow",
        from: { nodeId: "a", side: "right" },
        to: { nodeId: "b", side: "left" },
      }],
    }],
  });

  it("writes one deterministic JSON file per map and markers only for empty leaves", () => {
    const encoded = encodeMindMapPayload(payload);
    expect([...encoded.keys()]).toEqual([
      "资料/空文件夹/.gitkeep",
      "资料/项目/规划.json",
    ]);
    expect(encoded.get("资料/空文件夹/.gitkeep")).toBe("");
    expect(encoded.get("资料/项目/规划.json")).toBe(
      `${JSON.stringify({
        id: "map-1",
        nodes: payload.maps[0]!.nodes,
        arrows: payload.maps[0]!.arrows,
      }, null, 2)}\n`,
    );
    expect(encodeMindMapPayload(structuredClone(payload))).toEqual(encoded);
  });

  it("round-trips the complete normalized payload", () => {
    expect(decodeMindMapPayload(encodeMindMapPayload(payload))).toEqual(payload);
  });

  it("reconstructs every parent folder from managed file paths", () => {
    const decoded = decodeMindMapPayload(new Map([
      ["甲/乙/图.json", JSON.stringify({ id: "m", nodes: [], arrows: [] })],
    ]));
    expect(decoded.folders).toEqual(["甲", "甲/乙"]);
    expect(decoded.maps[0]?.path).toBe("甲/乙/图");
  });

  it("rejects malformed, unknown and non-normalized managed content", () => {
    expect(() => decodeMindMapPayload(new Map([["note.txt", ""]]))).toThrow(/Unsupported/);
    expect(() => decodeMindMapPayload(new Map([["Folder/.gitkeep", "not empty"]]))).toThrow(/empty/);
    expect(() => decodeMindMapPayload(new Map([[
      "Map.json",
      JSON.stringify({ id: "m", nodes: [], arrows: [], extra: true }),
    ]]))).toThrow(/properties/);
    expect(() => decodeMindMapPayload(new Map([[
      " Map.json",
      JSON.stringify({ id: "m", nodes: [], arrows: [] }),
    ]]))).toThrow(/normalized/);
  });
});
