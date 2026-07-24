import { describe, expect, it } from "vitest";
import {
  applyFragmentThoughtsEvent,
  createEmptyFragmentThoughtsPayload,
  invertFragmentThoughtsEvent,
  normalizeFragmentThoughtContent,
  validateFragmentThoughtsPayload,
  type FragmentThought,
  type FragmentThoughtsEvent,
  type FragmentThoughtsPayload,
  type FragmentThoughtVersion,
} from "../../src/fragment-thoughts/domain";
import { fragmentThoughtsDefinition } from "../../src/fragment-thoughts/definition";
import { StagingHistory } from "../../src/shared/history";

const THOUGHT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_THOUGHT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_1_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION_2_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION_3_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function version(
  id: string,
  content: string,
  createdAt: string,
): FragmentThoughtVersion {
  return { id, content, createdAt };
}

function thought(
  id = THOUGHT_ID,
  versions: readonly FragmentThoughtVersion[] = [
    version(VERSION_1_ID, "第一版", "2026-07-24T01:00:00.000Z"),
  ],
  collapsedVersionIds: readonly string[] = [],
): FragmentThought {
  return { id, versions, collapsedVersionIds };
}

function fixture(): FragmentThoughtsPayload {
  return validateFragmentThoughtsPayload({
    schemaVersion: 2,
    thoughts: [thought()],
  });
}

function roundTrip(
  payload: FragmentThoughtsPayload,
  event: FragmentThoughtsEvent,
): FragmentThoughtsPayload {
  const after = applyFragmentThoughtsEvent(payload, event);
  return applyFragmentThoughtsEvent(
    after,
    invertFragmentThoughtsEvent(event, payload, after),
  );
}

describe("Fragment Thoughts model", () => {
  it("creates the schema v2 empty payload and normalizes only line endings", () => {
    expect(createEmptyFragmentThoughtsPayload()).toEqual({
      schemaVersion: 2,
      thoughts: [],
    });
    expect(normalizeFragmentThoughtContent("  第一行\r\n第二行\r  ")).toBe(
      "  第一行\n第二行\n  ",
    );
  });

  it("rejects blank content, malformed UUIDs and non-canonical timestamps", () => {
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(THOUGHT_ID, [
        version(VERSION_1_ID, " \r\n\t ", "2026-07-24T01:00:00.000Z"),
      ])],
    })).toThrow(/blank/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought("not-a-uuid")],
    })).toThrow(/UUID/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(THOUGHT_ID, [
        version(VERSION_1_ID, "内容", "2026-07-24T09:00:00+08:00"),
      ])],
    })).toThrow(/canonical UTC ISO/);
  });

  it("requires exact fields, non-empty histories and strictly increasing times", () => {
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [],
      extra: true,
    })).toThrow(/properties/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 1,
      thoughts: [],
    })).toThrow(/schemaVersion/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [{ id: THOUGHT_ID, versions: [], collapsedVersionIds: [] }],
    })).toThrow(/at least one version/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(THOUGHT_ID, [
        version(VERSION_1_ID, "新", "2026-07-24T02:00:00.000Z"),
        version(VERSION_2_ID, "旧", "2026-07-24T01:00:00.000Z"),
      ])],
    })).toThrow(/strictly increasing/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [{
        id: THOUGHT_ID,
        versions: [
          version(VERSION_1_ID, "第一版", "2026-07-24T01:00:00.000Z"),
        ],
      }],
    })).toThrow(/properties/);
  });

  it("rejects duplicate thought and version identifiers across the payload", () => {
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(), thought()],
    })).toThrow(/Duplicate/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [
        thought(),
        thought(OTHER_THOUGHT_ID, [
          version(VERSION_1_ID, "重复版本 id", "2026-07-24T02:00:00.000Z"),
        ]),
      ],
    })).toThrow(/Duplicate/);
  });

  it("strictly validates and canonically orders persisted collapsed version ids", () => {
    const versions = [
      version(VERSION_1_ID, "第一版", "2026-07-24T01:00:00.000Z"),
      version(VERSION_2_ID, "第二版", "2026-07-24T02:00:00.000Z"),
    ];
    const normalized = validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(
        THOUGHT_ID,
        versions,
        [VERSION_2_ID.toUpperCase(), VERSION_1_ID],
      )],
    });
    expect(normalized.thoughts[0]?.collapsedVersionIds).toEqual([
      VERSION_1_ID,
      VERSION_2_ID,
    ]);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(THOUGHT_ID, versions, [VERSION_1_ID, VERSION_1_ID])],
    })).toThrow(/Duplicate collapsed/);
    expect(() => validateFragmentThoughtsPayload({
      schemaVersion: 2,
      thoughts: [thought(THOUGHT_ID, versions, [VERSION_3_ID])],
    })).toThrow(/does not exist/);
  });

  it("returns a detached payload without modifying its input", () => {
    const input = {
      schemaVersion: 2,
      thoughts: [thought(THOUGHT_ID, [
        version(VERSION_1_ID, "第一行\r\n第二行", "2026-07-24T01:00:00.000Z"),
      ])],
    } as const;
    const original = structuredClone(input);
    const result = validateFragmentThoughtsPayload(input);
    expect(input).toEqual(original);
    expect(result).not.toBe(input);
    expect(result.thoughts[0]).not.toBe(input.thoughts[0]);
    expect(result.thoughts[0]?.versions[0]?.content).toBe("第一行\n第二行");
  });
});

describe("Fragment Thoughts reversible events", () => {
  it("inserts and deletes a whole thought reversibly", () => {
    const empty = createEmptyFragmentThoughtsPayload();
    const insertedThought = thought();
    expect(roundTrip(empty, {
      type: "insert-thought",
      thought: insertedThought,
    })).toEqual(empty);

    const payload = fixture();
    const deleted = applyFragmentThoughtsEvent(payload, {
      type: "delete-thought",
      thoughtId: THOUGHT_ID,
    });
    expect(deleted.thoughts).toEqual([]);
    expect(roundTrip(payload, {
      type: "delete-thought",
      thoughtId: THOUGHT_ID,
    })).toEqual(payload);
  });

  it("appends and removes only the latest version reversibly", () => {
    const payload = fixture();
    const appendedVersion = version(
      VERSION_2_ID,
      "第二版",
      "2026-07-24T02:00:00.000Z",
    );
    const appended = applyFragmentThoughtsEvent(payload, {
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: appendedVersion,
      collapsed: false,
    });
    expect(appended.thoughts[0]?.versions).toHaveLength(2);
    expect(roundTrip(payload, {
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: appendedVersion,
      collapsed: false,
    })).toEqual(payload);

    expect(roundTrip(appended, {
      type: "remove-last-version",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_2_ID,
    })).toEqual(appended);
    expect(() => applyFragmentThoughtsEvent(payload, {
      type: "remove-last-version",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_1_ID,
    })).toThrow(/only.*cannot be removed/i);
    expect(() => applyFragmentThoughtsEvent(appended, {
      type: "remove-last-version",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_1_ID,
    })).toThrow(/latest/);

    const appendedCollapsed = applyFragmentThoughtsEvent(payload, {
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: appendedVersion,
      collapsed: true,
    });
    expect(appendedCollapsed.thoughts[0]?.collapsedVersionIds).toEqual([VERSION_2_ID]);
    expect(roundTrip(appendedCollapsed, {
      type: "remove-last-version",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_2_ID,
    })).toEqual(appendedCollapsed);
  });

  it("persists one version collapse or expansion as a reversible event", () => {
    const payload = fixture();
    const collapse: FragmentThoughtsEvent = {
      type: "set-version-collapsed",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_1_ID,
      collapsed: true,
    };
    const collapsed = applyFragmentThoughtsEvent(payload, collapse);
    expect(collapsed.thoughts[0]?.collapsedVersionIds).toEqual([VERSION_1_ID]);
    expect(roundTrip(payload, collapse)).toEqual(payload);
    expect(roundTrip(collapsed, {
      ...collapse,
      collapsed: false,
    })).toEqual(collapsed);
    expect(() => applyFragmentThoughtsEvent(payload, {
      ...collapse,
      versionId: VERSION_2_ID,
    })).toThrow(/does not exist/);
  });

  it("rejects invalid events atomically and never mutates payload or event", () => {
    const payload = fixture();
    const event: FragmentThoughtsEvent = {
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: version(
        VERSION_2_ID,
        "时间倒退",
        "2026-07-24T00:00:00.000Z",
      ),
      collapsed: false,
    };
    const originalPayload = structuredClone(payload);
    const originalEvent = structuredClone(event);
    expect(() => applyFragmentThoughtsEvent(payload, event)).toThrow(/strictly increasing/);
    expect(payload).toEqual(originalPayload);
    expect(event).toEqual(originalEvent);
  });
});

describe("Fragment Thoughts module definition and history", () => {
  it("uses the stable module id and a 100-event global history", () => {
    expect(fragmentThoughtsDefinition.moduleId).toBe("fragment-thoughts");
    expect(fragmentThoughtsDefinition.createEmpty()).toEqual(
      createEmptyFragmentThoughtsPayload(),
    );
    expect(fragmentThoughtsDefinition.history.capacity).toBe(100);
  });

  it("undoes and redoes complete thought and version events", () => {
    const history = new StagingHistory<FragmentThoughtsPayload, FragmentThoughtsEvent>(
      createEmptyFragmentThoughtsPayload(),
      {
        contentKey: fragmentThoughtsDefinition.contentKey,
        policy: fragmentThoughtsDefinition.history,
      },
    );
    const insertedThought = thought();
    history.dispatch({ type: "insert-thought", thought: insertedThought });
    history.dispatch({
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: version(
        VERSION_2_ID,
        "第二版",
        "2026-07-24T02:00:00.000Z",
      ),
      collapsed: false,
    });
    history.dispatch({
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: version(
        VERSION_3_ID,
        "第三版",
        "2026-07-24T03:00:00.000Z",
      ),
      collapsed: false,
    });
    history.dispatch({
      type: "set-version-collapsed",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_3_ID,
      collapsed: true,
    });
    history.dispatch({
      type: "set-version-collapsed",
      thoughtId: THOUGHT_ID,
      versionId: VERSION_3_ID,
      collapsed: true,
    });

    history.undo();
    expect(history.current.thoughts[0]?.collapsedVersionIds).toEqual([]);
    history.undo();
    expect(history.current.thoughts[0]?.versions).toHaveLength(2);
    history.undo();
    expect(history.current).toEqual({
      schemaVersion: 2,
      thoughts: [insertedThought],
    });
    history.redo();
    history.redo();
    history.redo();
    expect(history.current.thoughts[0]?.versions.at(-1)?.content).toBe("第三版");
    expect(history.current.thoughts[0]?.collapsedVersionIds).toEqual([VERSION_3_ID]);
  });
});
