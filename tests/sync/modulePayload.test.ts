import { describe, expect, it, vi } from "vitest";
import { hashContentKey } from "../../src/shared/sync/contentHash";
import {
  getModuleContentKey,
  hashModulePayload,
  prepareCurrentModulePayload,
  prepareStoredModulePayload,
  type ModulePayloadDefinition,
} from "../../src/shared/sync/modulePayload";
import {
  MissingModuleSchemaVersionError,
  UnsupportedModuleSchemaVersionError,
} from "../../src/shared/sync/types";

interface Payload {
  readonly value: string;
  readonly steps: number[];
}

function payloadDefinition(): ModulePayloadDefinition<Payload> {
  return {
    validate(value: unknown): Payload {
      const candidate = value as Partial<Payload>;
      if (
        typeof candidate?.value !== "string"
        || !Array.isArray(candidate.steps)
        || candidate.steps.some((step) => !Number.isSafeInteger(step))
      ) {
        throw new TypeError("invalid payload");
      }
      return candidate as Payload;
    },
    contentKey: (payload) => JSON.stringify(payload),
  };
}

describe("modulePayload", () => {
  it("validates current payloads across isolated clone boundaries", () => {
    const definition = payloadDefinition();
    const validate = vi.spyOn(definition, "validate");
    const input = { value: "draft", steps: [1] };

    const prepared = prepareCurrentModulePayload(definition, input);
    prepared.steps.push(2);

    expect(validate).toHaveBeenCalledTimes(2);
    expect(input).toEqual({ value: "draft", steps: [1] });
  });

  it("isolates contentKey callbacks and hashes their stable result", async () => {
    const definition: ModulePayloadDefinition<Payload> = {
      ...payloadDefinition(),
      contentKey(payload) {
        payload.steps.push(99);
        return `${payload.value}:${payload.steps.join(",")}`;
      },
    };
    const payload = { value: "safe", steps: [1] };

    expect(getModuleContentKey(definition, payload)).toBe("safe:1,99");
    await expect(hashModulePayload(definition, payload)).resolves.toBe(
      await hashContentKey("safe:1,99"),
    );
    expect(payload).toEqual({ value: "safe", steps: [1] });
  });

  it("migrates one version at a time without modifying stored input", () => {
    const migrate = vi.fn((value: unknown, fromVersion: number) => {
      const payload = value as Payload;
      payload.steps.push(fromVersion);
      return payload;
    });
    const definition: ModulePayloadDefinition<Payload> = {
      ...payloadDefinition(),
      migration: { currentVersion: 3, migrate },
    };
    const stored = { value: "legacy", steps: [] };

    const prepared = prepareStoredModulePayload(
      definition,
      stored,
      1,
      "local",
    );

    expect(prepared).toEqual({
      payload: { value: "legacy", steps: [1, 2] },
      migrated: true,
      fromVersion: 1,
      toVersion: 3,
    });
    expect(migrate.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(stored).toEqual({ value: "legacy", steps: [] });
  });

  it("reports current stored schemas without manufacturing a migration", () => {
    const definition: ModulePayloadDefinition<Payload> = {
      ...payloadDefinition(),
      migration: {
        currentVersion: 2,
        migrate: () => {
          throw new Error("must not migrate current data");
        },
      },
    };

    expect(prepareStoredModulePayload(
      definition,
      { value: "current", steps: [] },
      2,
      "remote",
    )).toEqual({
      payload: { value: "current", steps: [] },
      migrated: false,
      fromVersion: 2,
      toVersion: 2,
    });
  });

  it("rejects missing and future schema versions before validation", () => {
    const definition: ModulePayloadDefinition<Payload> = {
      ...payloadDefinition(),
      migration: { currentVersion: 2, migrate: (value) => value },
    };

    expect(() => prepareStoredModulePayload(
      definition,
      { value: "legacy", steps: [] },
      null,
      "remote",
    )).toThrow(MissingModuleSchemaVersionError);
    expect(() => prepareStoredModulePayload(
      definition,
      { value: "future", steps: [] },
      3,
      "local",
    )).toThrow(UnsupportedModuleSchemaVersionError);
  });
});
