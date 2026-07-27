import { describe, expect, it } from "vitest";
import {
  FRAGMENT_THOUGHTS_FILE_PATH,
  decodeFragmentThoughtsPayload,
  encodeFragmentThoughtsPayload,
  validateFragmentThoughtsPayload,
} from "../../src/fragment-thoughts/domain";

const payload = validateFragmentThoughtsPayload({
  thoughts: [{
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    versions: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        content: "第一版",
        createdAt: "2026-07-24T01:00:00.000Z",
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        content: "第二版\n保留空格  ",
        createdAt: "2026-07-24T02:00:00.000Z",
      },
    ],
    collapsedVersionIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  }],
});

const decodeAndValidate = (files: ReadonlyMap<string, string>) =>
  validateFragmentThoughtsPayload(decodeFragmentThoughtsPayload(files));

describe("Fragment Thoughts remote codec", () => {
  it("writes one deterministic two-space JSON file with a trailing newline", () => {
    const encoded = encodeFragmentThoughtsPayload(payload);
    expect([...encoded.keys()]).toEqual([FRAGMENT_THOUGHTS_FILE_PATH]);
    expect(encoded.get(FRAGMENT_THOUGHTS_FILE_PATH)).toBe(
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    expect(encodeFragmentThoughtsPayload(structuredClone(payload))).toEqual(encoded);
    const reorderedCollapsedIds = {
      ...payload,
      thoughts: [{
        ...payload.thoughts[0]!,
        collapsedVersionIds: [
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ],
      }],
    };
    const bothCollapsed = {
      ...payload,
      thoughts: [{
        ...payload.thoughts[0]!,
        collapsedVersionIds: [
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        ],
      }],
    };
    expect(encodeFragmentThoughtsPayload(reorderedCollapsedIds)).toEqual(
      encodeFragmentThoughtsPayload(bothCollapsed),
    );
  });

  it("round-trips the complete payload", () => {
    expect(decodeAndValidate(encodeFragmentThoughtsPayload(payload))).toEqual(
      payload,
    );
  });

  it("rejects missing, renamed and additional managed files", () => {
    expect(() => decodeFragmentThoughtsPayload(new Map())).toThrow(/Missing/);
    expect(() => decodeFragmentThoughtsPayload(new Map([
      ["other.json", "{}"],
    ]))).toThrow(/only thoughts\.json/);
    expect(() => decodeFragmentThoughtsPayload(new Map([
      [FRAGMENT_THOUGHTS_FILE_PATH, JSON.stringify(payload)],
      ["extra.json", "{}"],
    ]))).toThrow(/only thoughts\.json/);
  });

  it("rejects bad JSON, unexpected fields and invalid remote domain data", () => {
    expect(() => decodeFragmentThoughtsPayload(new Map([
      [FRAGMENT_THOUGHTS_FILE_PATH, "{"],
    ]))).toThrow(/not valid JSON/);
    expect(() => decodeAndValidate(new Map([
      [FRAGMENT_THOUGHTS_FILE_PATH, JSON.stringify({ ...payload, extra: true })],
    ]))).toThrow(/properties/);
    expect(() => decodeAndValidate(new Map([
      [FRAGMENT_THOUGHTS_FILE_PATH, JSON.stringify({
        schemaVersion: 1,
        thoughts: payload.thoughts,
      })],
    ]))).toThrow(/properties/);
    expect(() => decodeAndValidate(new Map([
      [FRAGMENT_THOUGHTS_FILE_PATH, JSON.stringify({
        ...payload,
        thoughts: [{
          ...payload.thoughts[0],
          collapsedVersionIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
        }],
      })],
    ]))).toThrow(/does not exist/);
    expect(() => decodeAndValidate(new Map([
      [FRAGMENT_THOUGHTS_FILE_PATH, JSON.stringify({
        thoughts: [{
          ...payload.thoughts[0],
          versions: [{
            ...payload.thoughts[0]!.versions[0],
            createdAt: "not-a-date",
          }],
        }],
      })],
    ]))).toThrow(/UTC ISO/);
  });
});
