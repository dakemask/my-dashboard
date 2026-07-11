import { describe, expect, it } from "vitest";

import { jsonContentKey, StagingHistory } from "../../src/shared/history";

function createHistory<T>(initial: T): StagingHistory<T> {
  return new StagingHistory(initial, { contentKey: jsonContentKey });
}

describe("StagingHistory", () => {
  it("keeps at most 100 complete versions", () => {
    const history = createHistory({ value: 0 });
    for (let value = 1; value <= 100; value += 1) {
      history.commit({ value });
    }

    expect(history.size).toBe(100);
    for (let count = 0; count < 99; count += 1) {
      history.undo();
    }
    expect(history.current).toEqual({ value: 1 });
    expect(history.canUndo).toBe(false);
  });

  it("replaces the redo branch after A-B-C, undo to B, commit D", () => {
    const history = createHistory({ value: "A" });
    history.commit({ value: "B" });
    history.commit({ value: "C" });

    expect(history.undo()).toEqual({ value: "B" });
    expect(history.commit({ value: "D" })).toEqual({ value: "D" });
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toEqual({ value: "B" });
    expect(history.undo()).toEqual({ value: "A" });
  });

  it("keeps history after save and derives dirty from the saved baseline", () => {
    const history = createHistory({ value: "A" });
    history.commit({ value: "B" });
    history.markSaved();

    expect(history.dirty).toBe(false);
    expect(history.undo()).toEqual({ value: "A" });
    expect(history.dirty).toBe(true);
    expect(history.redo()).toEqual({ value: "B" });
    expect(history.dirty).toBe(false);
  });

  it("becomes clean when content returns structurally to an external baseline", () => {
    const history = createHistory({ first: 1, second: 2 });
    history.commit({ first: 9, second: 2 });
    history.updateBaseline({ second: 2, first: 1 });

    expect(history.dirty).toBe(true);
    history.commit({ second: 2, first: 1 });
    expect(history.dirty).toBe(false);
  });

  it("does not retain or expose mutable caller objects", () => {
    const initial = { nested: { value: 1 } };
    const history = createHistory(initial);
    initial.nested.value = 2;

    expect(history.current).toEqual({ nested: { value: 1 } });
    const exposed = history.current;
    exposed.nested.value = 3;
    expect(history.current).toEqual({ nested: { value: 1 } });
  });

  it("supports non-JSON structured-clone payloads with a module content key", () => {
    const initial = new Map<string, Uint8Array>([["asset", new Uint8Array([1, 2])]]);
    const contentKey = (payload: Map<string, Uint8Array>): string =>
      [...payload]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, bytes]) => `${name}:${[...bytes].join(",")}`)
        .join("|");
    const history = new StagingHistory(initial, { contentKey });

    initial.get("asset")![0] = 9;
    expect([...history.current.get("asset")!]).toEqual([1, 2]);

    history.commit(new Map([["asset", new Uint8Array([3, 4])]]));
    expect(history.dirty).toBe(true);
    history.markSaved();
    expect(history.dirty).toBe(false);
  });

  it("does not expose an internal version to the module content-key callback", () => {
    let retained: { nested: { value: number } } | null = null;
    const history = new StagingHistory(
      { nested: { value: 1 } },
      {
        contentKey: (payload) => {
          retained = payload;
          return String(payload.nested.value);
        },
      },
    );

    (retained as unknown as { nested: { value: number } }).nested.value = 99;
    expect(history.current).toEqual({ nested: { value: 1 } });
  });

  it("starts a fresh one-step queue when reconstructed after refresh", () => {
    const beforeRefresh = createHistory({ value: "A" });
    beforeRefresh.commit({ value: "B" });

    const afterRefresh = createHistory(beforeRefresh.current);
    expect(afterRefresh.size).toBe(1);
    expect(afterRefresh.canUndo).toBe(false);
    expect(afterRefresh.dirty).toBe(false);
  });
});
