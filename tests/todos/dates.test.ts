import { describe, expect, it } from "vitest";
import {
  compareTodoInstances,
  parseTodoSpecificDate,
  reconcileTodoDates,
  todoStatus,
} from "../../src/todos/domain";
import { instance, task } from "./helpers";

describe("Todos dates", () => {
  it("uses earliest missing fields and ignores an incomplete two-digit field", () => {
    for (const value of ["202608", "2026081"]) {
      const date = new Date(parseTodoSpecificDate(value, "reminder")!);
      expect(date.getFullYear()).toBe(2026);
      expect(date.getMonth()).toBe(7);
      expect(date.getDate()).toBe(1);
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
    }
  });

  it("clamps an invalid day downward", () => {
    const date = new Date(parseTodoSpecificDate("20260231", "deadline")!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(28);
  });

  it("maps negative reminder to now and negative deadline to infinity", () => {
    const now = new Date("2026-08-01T03:04:05.000Z");
    expect(parseTodoSpecificDate("-8", "reminder", now)).toBe(now.toISOString());
    expect(parseTodoSpecificDate("-1", "deadline", now)).toBeNull();
  });

  it("lets the last changed date enforce reminder before deadline", () => {
    const early = "2026-08-01T00:00:00.000Z";
    const late = "2026-08-02T00:00:00.000Z";
    expect(reconcileTodoDates(late, early, "reminder")).toEqual({ reminderAt: late, deadlineAt: late });
    expect(reconcileTodoDates(late, early, "deadline")).toEqual({ reminderAt: early, deadlineAt: early });
  });

  it("classifies and sorts status groups by urgency", () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const overdue = { ...instance(task(1), 101), reminderAt: "2026-08-01T00:00:00.000Z", deadlineAt: "2026-08-09T00:00:00.000Z" };
    const reminded = { ...instance(task(2), 102), reminderAt: "2026-08-09T00:00:00.000Z", deadlineAt: "2026-08-11T00:00:00.000Z" };
    const pending = { ...instance(task(3), 103), reminderAt: "2026-08-11T00:00:00.000Z", deadlineAt: null };
    expect(todoStatus(overdue, now)).toBe("overdue");
    expect(todoStatus(reminded, now)).toBe("reminded");
    expect(todoStatus(pending, now)).toBe("pending");
    expect([pending, reminded, overdue].sort((a, b) => compareTodoInstances(a, b, now)))
      .toEqual([overdue, reminded, pending]);
  });
});

