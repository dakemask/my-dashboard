export type TodoCadence = "weekly" | "monthly";

export interface TodoTask {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
  readonly completed: boolean;
  readonly predecessorId: string | null;
  readonly children: readonly TodoTask[];
}

export interface TodoInstance {
  readonly id: string;
  readonly createdAt: string;
  readonly reminderAt: string;
  readonly deadlineAt: string | null;
  readonly completedAt: string | null;
  readonly expanded: boolean;
  readonly sourceRuleId: string | null;
  readonly sourcePeriodKey: string | null;
  readonly root: TodoTask;
}

export interface TodoGenerationCursor {
  readonly weekly: string | null;
  readonly monthly: string | null;
}

export interface TodoRecurrenceRule {
  readonly id: string;
  readonly createdAt: string;
  readonly cadence: TodoCadence;
  readonly template: TodoTask;
  readonly generatedThrough: TodoGenerationCursor;
}

export interface TodosPayload {
  readonly instances: readonly TodoInstance[];
  readonly rules: readonly TodoRecurrenceRule[];
}

export interface TodoEntityChange<T> {
  readonly id: string;
  readonly before: T | null;
  readonly after: T | null;
  readonly beforeIndex: number;
  readonly afterIndex: number;
}

export interface TodosEvent {
  readonly type: "change-entities";
  readonly instances: readonly TodoEntityChange<TodoInstance>[];
  readonly rules: readonly TodoEntityChange<TodoRecurrenceRule>[];
}

export type TodoStatus = "overdue" | "reminded" | "pending" | "completed";

