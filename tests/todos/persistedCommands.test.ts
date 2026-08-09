import { describe, expect, it } from "vitest";
import {
  executeTodoPersistedCommand,
  executeTodoSave,
  planTodoCommandState,
  planTodoRetryState,
  type TodoCommandRuntime,
  type TodoRuntimeCommand,
} from "../../src/todos/app/persistedCommands";

interface TestPayload {
  readonly revision: number;
}

type TestEvent = { readonly next: TestPayload };

class FakeRuntime implements TodoCommandRuntime<TestPayload, TestEvent> {
  readonly calls: string[] = [];
  current: TestPayload = { revision: 0 };
  undoPayload: TestPayload = { revision: -1 };
  redoPayload: TestPayload = { revision: 1 };
  commandFailure: "dispatch" | "undo" | "redo" | null = null;
  saveFails = false;

  dispatch(event: TestEvent): TestPayload {
    this.calls.push("dispatch");
    if (this.commandFailure === "dispatch") throw new Error("dispatch failed");
    this.current = event.next;
    return this.current;
  }

  async undo(): Promise<TestPayload> {
    this.calls.push("undo");
    if (this.commandFailure === "undo") throw new Error("undo failed");
    this.current = this.undoPayload;
    return this.current;
  }

  async redo(): Promise<TestPayload> {
    this.calls.push("redo");
    if (this.commandFailure === "redo") throw new Error("redo failed");
    this.current = this.redoPayload;
    return this.current;
  }

  async save(): Promise<void> {
    this.calls.push("save");
    if (this.saveFails) throw new Error("save failed");
  }
}

describe("Todos persisted commands", () => {
  it("keeps and projects a successful dispatch before a failed save", async () => {
    const runtime = new FakeRuntime();
    runtime.saveFails = true;
    let projected: TestPayload | null = null;
    const result = await executeTodoPersistedCommand(
      runtime,
      { kind: "dispatch", event: { next: { revision: 2 } } },
      (payload) => {
        runtime.calls.push("project");
        projected = payload;
      },
    );

    expect(runtime.calls).toEqual(["dispatch", "project", "save"]);
    expect(projected).toEqual({ revision: 2 });
    expect(runtime.current).toEqual({ revision: 2 });
    expect(result).toMatchObject({ status: "save-failed", payload: { revision: 2 } });
    expect(planTodoCommandState(false, result)).toEqual({
      localSaveFailed: true,
      commandFailureMessage: null,
    });
  });

  it("clears an earlier save failure after a command and save both succeed", async () => {
    const runtime = new FakeRuntime();
    const result = await executeTodoPersistedCommand(
      runtime,
      { kind: "dispatch", event: { next: { revision: 2 } } },
      () => undefined,
    );
    expect(result.status).toBe("saved");
    expect(planTodoCommandState(true, result)).toEqual({
      localSaveFailed: false,
      commandFailureMessage: null,
    });
  });

  it.each([
    ["undo", { revision: -2 }],
    ["redo", { revision: 3 }],
  ] as const)("keeps a successful %s when its following save fails", async (kind, payload) => {
    const runtime = new FakeRuntime();
    runtime.saveFails = true;
    if (kind === "undo") runtime.undoPayload = payload;
    else runtime.redoPayload = payload;
    let projected: TestPayload | null = null;

    const result = await executeTodoPersistedCommand(
      runtime,
      { kind } as TodoRuntimeCommand<TestEvent>,
      (next) => {
        runtime.calls.push("project");
        projected = next;
      },
    );

    expect(runtime.calls).toEqual([kind, "project", "save"]);
    expect(projected).toEqual(payload);
    expect(runtime.current).toEqual(payload);
    expect(planTodoCommandState(false, result).localSaveFailed).toBe(true);
    expect(planTodoCommandState(false, result).commandFailureMessage).toBeNull();
  });

  it.each([
    ["dispatch", "更改未能应用，页面内容未发生变化。"],
    ["undo", "撤销未能完成，页面内容未发生变化。"],
    ["redo", "重做未能完成，页面内容未发生变化。"],
  ] as const)("reports a genuine %s failure without attempting save", async (kind, message) => {
    const runtime = new FakeRuntime();
    runtime.commandFailure = kind;
    let projected = false;
    const command: TodoRuntimeCommand<TestEvent> = kind === "dispatch"
      ? { kind, event: { next: { revision: 2 } } }
      : { kind };

    const result = await executeTodoPersistedCommand(runtime, command, () => {
      projected = true;
    });

    expect(result.status).toBe("command-failed");
    expect(runtime.calls).toEqual([kind]);
    expect(projected).toBe(false);
    expect(planTodoCommandState(true, result)).toEqual({
      localSaveFailed: true,
      commandFailureMessage: message,
    });
  });

  it("clears the persistent failure state only after a successful retry", async () => {
    const runtime = new FakeRuntime();
    runtime.saveFails = true;
    const failed = await executeTodoSave(runtime);
    expect(planTodoRetryState(failed)).toBe(true);

    runtime.saveFails = false;
    const saved = await executeTodoSave(runtime);
    expect(planTodoRetryState(saved)).toBe(false);
    expect(runtime.calls).toEqual(["save", "save"]);
  });
});
