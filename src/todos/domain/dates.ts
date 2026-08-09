import { isTaskComplete } from "./tasks";
import type { TodoInstance, TodoStatus } from "./types";

export type TodoDateRole = "reminder" | "deadline";

export function parseTodoSpecificDate(
  rawValue: string,
  role: TodoDateRole,
  now = new Date(),
): string | null {
  const value = rawValue.trim();
  if (/^-\d+$/u.test(value)) {
    return role === "deadline" ? null : now.toISOString();
  }
  if (!/^\d{6,12}$/u.test(value)) {
    throw new TypeError("日期必须至少填写 YYYYMM，并最多填写到 YYYYMMDDHHmm。");
  }
  const year = Number(value.slice(0, 4));
  const month = clamp(Number(value.slice(4, 6)), 1, 12);
  const day = value.length >= 8 ? Number(value.slice(6, 8)) : 1;
  const hour = value.length >= 10 ? Number(value.slice(8, 10)) : 0;
  const minute = value.length >= 12 ? Number(value.slice(10, 12)) : 0;
  const maxDay = daysInLocalMonth(year, month);
  const date = new Date(0);
  date.setMilliseconds(0);
  date.setSeconds(0);
  date.setMinutes(clamp(minute, 0, 59));
  date.setHours(clamp(hour, 0, 23));
  date.setDate(clamp(day, 1, maxDay));
  date.setMonth(month - 1);
  date.setFullYear(year);
  return date.toISOString();
}

export function deadlineFromReminder(reminderAt: string, days: number): string {
  return addLocalDays(requireNonNegativeInteger(days), reminderAt);
}

export function reminderFromDeadline(deadlineAt: string, days: number): string {
  return addLocalDays(-requireNonNegativeInteger(days), deadlineAt);
}

export function reconcileTodoDates(
  reminderAt: string,
  deadlineAt: string | null,
  changed: TodoDateRole,
): { reminderAt: string; deadlineAt: string | null } {
  if (deadlineAt === null) return { reminderAt, deadlineAt };
  const reminder = Date.parse(reminderAt);
  const deadline = Date.parse(deadlineAt);
  if (reminder <= deadline) return { reminderAt, deadlineAt };
  return changed === "reminder"
    ? { reminderAt, deadlineAt: reminderAt }
    : { reminderAt: deadlineAt, deadlineAt };
}

export function todoStatus(instance: TodoInstance, now = new Date()): TodoStatus {
  if (isTaskComplete(instance.root)) return "completed";
  const time = now.getTime();
  if (instance.deadlineAt !== null && time >= Date.parse(instance.deadlineAt)) return "overdue";
  if (time >= Date.parse(instance.reminderAt)) return "reminded";
  return "pending";
}

export function compareTodoInstances(
  left: TodoInstance,
  right: TodoInstance,
  now = new Date(),
): number {
  const rank: Record<TodoStatus, number> = {
    overdue: 0,
    reminded: 1,
    pending: 2,
    completed: 3,
  };
  const leftStatus = todoStatus(left, now);
  const rightStatus = todoStatus(right, now);
  const group = rank[leftStatus] - rank[rightStatus];
  if (group !== 0) return group;
  let time = 0;
  if (leftStatus === "overdue") {
    time = Date.parse(left.deadlineAt!) - Date.parse(right.deadlineAt!);
  } else if (leftStatus === "reminded") {
    time = deadlineValue(left) - deadlineValue(right);
  } else if (leftStatus === "pending") {
    time = Date.parse(left.reminderAt) - Date.parse(right.reminderAt);
  } else {
    time = Date.parse(right.completedAt!) - Date.parse(left.completedAt!);
  }
  if (time !== 0) return time;
  const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return created !== 0 ? created : left.id.localeCompare(right.id);
}

export function formatTodoDateInput(value: string | null): string {
  if (value === null) return "-1";
  const date = new Date(value);
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
    date.getHours().toString().padStart(2, "0"),
    date.getMinutes().toString().padStart(2, "0"),
  ].join("");
}

function daysInLocalMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month, 0);
  return date.getDate();
}

function addLocalDays(days: number, iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid base Todo date.");
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function requireNonNegativeInteger(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("相对天数必须是非负整数。");
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function deadlineValue(instance: TodoInstance): number {
  return instance.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(instance.deadlineAt);
}
