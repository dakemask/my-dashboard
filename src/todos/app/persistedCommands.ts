export type TodoRuntimeCommandKind = "dispatch" | "undo" | "redo";

export type TodoRuntimeCommand<TEvent> =
  | { readonly kind: "dispatch"; readonly event: TEvent }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

export interface TodoCommandRuntime<TPayload, TEvent> {
  dispatch(event: TEvent): TPayload;
  undo(): Promise<TPayload>;
  redo(): Promise<TPayload>;
  save(): Promise<unknown>;
}

export type TodoCommandExecutionResult<TPayload> =
  | {
    readonly status: "command-failed";
    readonly kind: TodoRuntimeCommandKind;
    readonly error: unknown;
  }
  | {
    readonly status: "saved";
    readonly kind: TodoRuntimeCommandKind;
    readonly payload: TPayload;
  }
  | {
    readonly status: "save-failed";
    readonly kind: TodoRuntimeCommandKind;
    readonly payload: TPayload;
    readonly error: unknown;
  };

export type TodoSaveExecutionResult =
  | { readonly status: "saved" }
  | { readonly status: "save-failed"; readonly error: unknown };

export interface TodoCommandStatePlan {
  readonly localSaveFailed: boolean;
  readonly commandFailureMessage: string | null;
}

export async function executeTodoPersistedCommand<TPayload, TEvent>(
  runtime: TodoCommandRuntime<TPayload, TEvent>,
  command: TodoRuntimeCommand<TEvent>,
  onApplied: (payload: TPayload) => void,
): Promise<TodoCommandExecutionResult<TPayload>> {
  let payload: TPayload;
  try {
    if (command.kind === "dispatch") payload = runtime.dispatch(command.event);
    else if (command.kind === "undo") payload = await runtime.undo();
    else payload = await runtime.redo();
  } catch (error) {
    return { status: "command-failed", kind: command.kind, error };
  }

  // Applying the returned payload is deliberately before persistence. A failed
  // local save must never roll back a command that the Runtime already accepted.
  onApplied(payload);
  try {
    await runtime.save();
    return { status: "saved", kind: command.kind, payload };
  } catch (error) {
    return { status: "save-failed", kind: command.kind, payload, error };
  }
}

export async function executeTodoSave(
  runtime: Pick<TodoCommandRuntime<unknown, unknown>, "save">,
): Promise<TodoSaveExecutionResult> {
  try {
    await runtime.save();
    return { status: "saved" };
  } catch (error) {
    return { status: "save-failed", error };
  }
}

export function planTodoCommandState(
  currentLocalSaveFailed: boolean,
  result: TodoCommandExecutionResult<unknown>,
): TodoCommandStatePlan {
  if (result.status === "command-failed") {
    return {
      localSaveFailed: currentLocalSaveFailed,
      commandFailureMessage: commandFailureMessage(result.kind),
    };
  }
  return {
    localSaveFailed: result.status === "save-failed",
    commandFailureMessage: null,
  };
}

export function planTodoRetryState(result: TodoSaveExecutionResult): boolean {
  return result.status === "save-failed";
}

function commandFailureMessage(kind: TodoRuntimeCommandKind): string {
  if (kind === "undo") return "撤销未能完成，页面内容未发生变化。";
  if (kind === "redo") return "重做未能完成，页面内容未发生变化。";
  return "更改未能应用，页面内容未发生变化。";
}
