import { describe, expect, it } from "vitest";
import {
  generateMissingPeriodicInstances,
  initializeRulePeriod,
  todoPeriod,
} from "../../src/todos/domain";
import { id, payload, rule, task } from "./helpers";

describe("Todos recurrence", () => {
  it("uses local Monday and next Monday for weekly periods", () => {
    const period = todoPeriod("weekly", new Date(2026, 7, 6, 13, 20));
    expect(period.start.getDay()).toBe(1);
    expect(period.start.getHours()).toBe(0);
    expect(period.end.getDay()).toBe(1);
    expect(period.end.getDate() - period.start.getDate()).toBe(7);
  });

  it("generates the current instance once when a rule is created", () => {
    let counter = 300;
    const createId = () => id(counter++);
    const source = rule(task(1), 200);
    const first = initializeRulePeriod(source, new Date(2026, 7, 6, 10), createId);
    expect(first.instance?.sourceRuleId).toBe(source.id);
    expect(first.instance?.root.id).not.toBe(source.template.id);
    expect(first.rule.generatedThrough.weekly).toBeTruthy();
    const second = initializeRulePeriod(first.rule, new Date(2026, 7, 6, 11), createId);
    expect(second.instance).toBeNull();
  });

  it("fills every missed active weekly period and advances the cursor", () => {
    let counter = 300;
    const source = {
      ...rule(task(1), 200),
      generatedThrough: {
        weekly: todoPeriod("weekly", new Date(2026, 6, 27)).start.toISOString(),
        monthly: null,
      },
    };
    const result = generateMissingPeriodicInstances(
      payload([], [source]),
      new Date(2026, 7, 12),
      () => id(counter++),
    );
    expect(result.instances).toHaveLength(2);
    expect(result.rules[0]?.generatedThrough.weekly)
      .toBe(todoPeriod("weekly", new Date(2026, 7, 12)).start.toISOString());
  });

  it("uses month start and next month start", () => {
    const period = todoPeriod("monthly", new Date(2026, 7, 19, 12));
    expect([period.start.getDate(), period.start.getHours()]).toEqual([1, 0]);
    expect(period.end.getMonth()).toBe(8);
    expect(period.end.getDate()).toBe(1);
  });
});

