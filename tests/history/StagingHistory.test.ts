import { describe, expect, it } from "vitest";

import { StagingHistory } from "../../src/shared/history";

describe("StagingHistory", () => {
  it("keeps at most 100 complete versions", () => {
    const history = new StagingHistory({ value: 0 });
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
    const history = new StagingHistory({ value: "A" });
    history.commit({ value: "B" });
    history.commit({ value: "C" });

    expect(history.undo()).toEqual({ value: "B" });
    expect(history.commit({ value: "D" })).toEqual({ value: "D" });
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toEqual({ value: "B" });
    expect(history.undo()).toEqual({ value: "A" });
  });

  it("keeps history after save and derives dirty from the saved baseline", () => {
    const history = new StagingHistory({ value: "A" });
    history.commit({ value: "B" });
    history.markSaved();

    expect(history.dirty).toBe(false);
    expect(history.undo()).toEqual({ value: "A" });
    expect(history.dirty).toBe(true);
    expect(history.redo()).toEqual({ value: "B" });
    expect(history.dirty).toBe(false);
  });

  it("becomes clean when content returns structurally to an external baseline", () => {
    const history = new StagingHistory({ first: 1, second: 2 });
    history.commit({ first: 9, second: 2 });
    history.updateBaseline({ second: 2, first: 1 });

    expect(history.dirty).toBe(true);
    history.commit({ second: 2, first: 1 });
    expect(history.dirty).toBe(false);
  });

  it("takes immutable JSON snapshots instead of retaining caller objects", () => {
    const initial = { nested: { value: 1 } };
    const history = new StagingHistory(initial);
    initial.nested.value = 2;

    expect(history.current).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen(history.current)).toBe(true);
    expect(Object.isFrozen(history.current.nested)).toBe(true);
    expect(() => new StagingHistory({ invalid: undefined })).toThrow(TypeError);
  });

  it("starts a fresh one-step queue when reconstructed after refresh", () => {
    const beforeRefresh = new StagingHistory({ value: "A" });
    beforeRefresh.commit({ value: "B" });

    const afterRefresh = new StagingHistory(beforeRefresh.current);
    expect(afterRefresh.size).toBe(1);
    expect(afterRefresh.canUndo).toBe(false);
    expect(afterRefresh.dirty).toBe(false);
  });
});
