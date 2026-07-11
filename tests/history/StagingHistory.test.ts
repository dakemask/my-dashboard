import { describe, expect, it, vi } from "vitest";

import {
  jsonContentKey,
  type ModuleHistoryPolicy,
  StagingHistory,
} from "../../src/shared/history";

interface ValuePayload<T = string> {
  value: T;
}

interface SetValueEvent<T = string> {
  value: T;
}

function createPolicy<T>(
  capacity: number | "unlimited" = 100,
): ModuleHistoryPolicy<ValuePayload<T>, SetValueEvent<T>> {
  return {
    capacity,
    apply: (payload, event) => ({ ...payload, value: event.value }),
    invert: (_event, before) => ({ value: before.value }),
  };
}

function createHistory<T>(
  initial: T,
  capacity: number | "unlimited" = 100,
): StagingHistory<ValuePayload<T>, SetValueEvent<T>> {
  return new StagingHistory(
    { value: initial },
    { contentKey: jsonContentKey, policy: createPolicy(capacity) },
  );
}

describe("StagingHistory", () => {
  it("retains only the configured number of reversible events", () => {
    const history = createHistory(0, 3);
    for (let value = 1; value <= 4; value += 1) {
      history.dispatch({ value });
    }

    expect(history.size).toBe(3);
    expect(history.undo()).toEqual({ value: 3 });
    expect(history.undo()).toEqual({ value: 2 });
    expect(history.undo()).toEqual({ value: 1 });
    expect(history.canUndo).toBe(false);
  });

  it("supports an unlimited event queue", () => {
    const history = createHistory(0, "unlimited");
    for (let value = 1; value <= 150; value += 1) {
      history.dispatch({ value });
    }

    expect(history.size).toBe(150);
    for (let count = 0; count < 150; count += 1) {
      history.undo();
    }
    expect(history.current).toEqual({ value: 0 });
    expect(history.canUndo).toBe(false);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid numeric capacity %s",
    (capacity) => {
      expect(() => createHistory("A", capacity)).toThrow(RangeError);
    },
  );

  it("replaces the redo branch after A-B-C, undo to B, dispatch D", () => {
    const history = createHistory("A");
    history.dispatch({ value: "B" });
    history.dispatch({ value: "C" });

    expect(history.undo()).toEqual({ value: "B" });
    expect(history.dispatch({ value: "D" })).toEqual({ value: "D" });
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toEqual({ value: "B" });
    expect(history.undo()).toEqual({ value: "A" });
  });

  it("does not record a no-op or destroy its redo branch", () => {
    const invert = vi.fn((_event: SetValueEvent, before: ValuePayload) => ({
      value: before.value,
    }));
    const history = new StagingHistory<ValuePayload, SetValueEvent>(
      { value: "A" },
      {
        contentKey: jsonContentKey,
        policy: {
          ...createPolicy(10),
          invert,
        },
      },
    );
    history.dispatch({ value: "B" });
    history.dispatch({ value: "C" });
    history.undo();
    invert.mockClear();

    expect(history.dispatch({ value: "B" })).toEqual({ value: "B" });
    expect(history.size).toBe(2);
    expect(history.canRedo).toBe(true);
    expect(invert).not.toHaveBeenCalled();
    expect(history.redo()).toEqual({ value: "C" });
  });

  it("keeps history after save and derives dirty from the saved baseline", () => {
    const history = createHistory("A");
    history.dispatch({ value: "B" });
    history.markSaved();

    expect(history.dirty).toBe(false);
    expect(history.undo()).toEqual({ value: "A" });
    expect(history.dirty).toBe(true);
    expect(history.redo()).toEqual({ value: "B" });
    expect(history.dirty).toBe(false);
    expect(history.size).toBe(1);
  });

  it("becomes clean when an event returns to an external baseline", () => {
    const history = createHistory("A");
    history.dispatch({ value: "B" });
    history.updateBaseline({ value: "A" });

    expect(history.dirty).toBe(true);
    history.dispatch({ value: "A" });
    expect(history.dirty).toBe(false);
  });

  it("isolates the current payload, forward event and inverse event from mutation", () => {
    type Payload = { nested: { value: string } };
    type Event = { nested: { value: string } };
    const retained: Array<Payload | Event> = [];
    const policy: ModuleHistoryPolicy<Payload, Event> = {
      capacity: 10,
      apply: (payload, event) => {
        retained.push(payload, event);
        payload.nested.value = event.nested.value;
        event.nested.value = "changed inside apply";
        return payload;
      },
      invert: (event, before, after) => {
        retained.push(event, before, after);
        event.nested.value = "changed inside invert";
        return { nested: { value: before.nested.value } };
      },
    };
    const initial: Payload = { nested: { value: "A" } };
    const event: Event = { nested: { value: "B" } };
    const history = new StagingHistory(initial, {
      contentKey: jsonContentKey,
      policy,
    });

    initial.nested.value = "changed initial";
    history.dispatch(event);
    event.nested.value = "changed caller event";
    for (const retainedValue of retained) {
      retainedValue.nested.value = "changed retained callback input";
    }
    const exposed = history.current;
    exposed.nested.value = "changed exposed current";

    expect(history.current).toEqual({ nested: { value: "B" } });
    expect(history.undo()).toEqual({ nested: { value: "A" } });
    expect(history.redo()).toEqual({ nested: { value: "B" } });
  });

  it("leaves the entire history unchanged when apply or invert throws", () => {
    type Event = SetValueEvent & { fail?: "apply" | "invert" };
    const history = new StagingHistory<ValuePayload, Event>(
      { value: "A" },
      {
        contentKey: jsonContentKey,
        policy: {
          capacity: 10,
          apply: (payload, event) => {
            if (event.fail === "apply") {
              throw new Error("apply failed");
            }
            return { ...payload, value: event.value };
          },
          invert: (event, before) => {
            if (event.fail === "invert") {
              throw new Error("invert failed");
            }
            return { value: before.value };
          },
        },
      },
    );
    history.dispatch({ value: "B" });
    history.dispatch({ value: "C" });
    history.undo();

    expect(() => history.dispatch({ value: "X", fail: "apply" })).toThrow(
      "apply failed",
    );
    expect(history.current).toEqual({ value: "B" });
    expect(history.size).toBe(2);
    expect(history.canRedo).toBe(true);

    expect(() => history.dispatch({ value: "Y", fail: "invert" })).toThrow(
      "invert failed",
    );
    expect(history.current).toEqual({ value: "B" });
    expect(history.size).toBe(2);
    expect(history.canRedo).toBe(true);
    expect(history.redo()).toEqual({ value: "C" });
  });

  it("leaves dispatch, undo and redo unchanged when contentKey throws", () => {
    let rejectedValue = "";
    const history = new StagingHistory<ValuePayload, SetValueEvent>(
      { value: "A" },
      {
        contentKey: (payload) => {
          if (payload.value === rejectedValue) {
            throw new Error("content key failed");
          }
          return payload.value;
        },
        policy: createPolicy(10),
      },
    );
    history.dispatch({ value: "B" });
    history.dispatch({ value: "C" });
    history.undo();

    rejectedValue = "X";
    expect(() => history.dispatch({ value: "X" })).toThrow("content key failed");
    expect(history.current).toEqual({ value: "B" });
    expect(history.size).toBe(2);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(true);

    rejectedValue = "A";
    expect(() => history.undo()).toThrow("content key failed");
    expect(history.current).toEqual({ value: "B" });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(true);

    rejectedValue = "C";
    expect(() => history.redo()).toThrow("content key failed");
    expect(history.current).toEqual({ value: "B" });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(true);
  });

  it("keeps undo and redo atomic when applying a retained event fails", () => {
    let failOn = "";
    const history = new StagingHistory<ValuePayload, SetValueEvent>(
      { value: "A" },
      {
        contentKey: jsonContentKey,
        policy: {
          capacity: 10,
          apply: (payload, event) => {
            if (event.value === failOn) {
              throw new Error("replay failed");
            }
            return { ...payload, value: event.value };
          },
          invert: (_event, before) => ({ value: before.value }),
        },
      },
    );
    history.dispatch({ value: "B" });
    history.dispatch({ value: "C" });

    failOn = "B";
    expect(() => history.undo()).toThrow("replay failed");
    expect(history.current).toEqual({ value: "C" });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    failOn = "";
    history.undo();
    failOn = "C";
    expect(() => history.redo()).toThrow("replay failed");
    expect(history.current).toEqual({ value: "B" });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(true);
  });

  it("rejects replay results that do not match the recorded before and after keys", () => {
    let corruptReplay = false;
    const history = new StagingHistory<ValuePayload, SetValueEvent>(
      { value: "A" },
      {
        contentKey: jsonContentKey,
        policy: {
          capacity: 10,
          apply: (payload, event) => ({
            ...payload,
            value: corruptReplay ? "corrupted" : event.value,
          }),
          invert: (_event, before) => ({ value: before.value }),
        },
      },
    );
    history.dispatch({ value: "B" });

    corruptReplay = true;
    expect(() => history.undo()).toThrow(
      "inverse event did not restore its before state",
    );
    expect(history.current).toEqual({ value: "B" });
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    corruptReplay = false;
    history.undo();
    corruptReplay = true;
    expect(() => history.redo()).toThrow(
      "forward event did not restore its after state",
    );
    expect(history.current).toEqual({ value: "A" });
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });

  it("supports non-JSON structured-clone payloads and events", () => {
    type Payload = Map<string, Uint8Array>;
    type Event = { name: string; bytes?: Uint8Array };
    const contentKey = (payload: Payload): string =>
      [...payload]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, bytes]) => `${name}:${[...bytes].join(",")}`)
        .join("|");
    const history = new StagingHistory<Payload, Event>(
      new Map([["asset", new Uint8Array([1, 2])]]),
      {
        contentKey,
        policy: {
          capacity: "unlimited",
          apply: (payload, event) => {
            if (event.bytes) {
              payload.set(event.name, event.bytes);
            } else {
              payload.delete(event.name);
            }
            return payload;
          },
          invert: (event, before) => ({
            name: event.name,
            bytes: before.get(event.name),
          }),
        },
      },
    );
    const bytes = new Uint8Array([3, 4]);

    history.dispatch({ name: "asset", bytes });
    bytes[0] = 9;
    expect([...history.current.get("asset")!]).toEqual([3, 4]);
    expect([...history.undo().get("asset")!]).toEqual([1, 2]);
    expect([...history.redo().get("asset")!]).toEqual([3, 4]);
  });

  it("does not expose internal state to the content-key callback", () => {
    let retained: ValuePayload<{ count: number }> | null = null;
    const history = new StagingHistory<
      ValuePayload<{ count: number }>,
      SetValueEvent<{ count: number }>
    >(
      { value: { count: 1 } },
      {
        contentKey: (payload) => {
          retained = payload;
          return String(payload.value.count);
        },
        policy: createPolicy(10),
      },
    );

    (retained as unknown as ValuePayload<{ count: number }>).value.count = 99;
    expect(history.current).toEqual({ value: { count: 1 } });
  });

  it("starts a fresh empty event queue when reconstructed after refresh", () => {
    const beforeRefresh = createHistory("A");
    beforeRefresh.dispatch({ value: "B" });

    const afterRefresh = new StagingHistory(beforeRefresh.current, {
      contentKey: jsonContentKey,
      policy: createPolicy(10),
    });
    expect(afterRefresh.size).toBe(0);
    expect(afterRefresh.canUndo).toBe(false);
    expect(afterRefresh.dirty).toBe(false);
  });
});
