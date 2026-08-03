import { describe, expect, it } from "vitest";
import {
  beginEditingDraft,
  completePendingDraftApplication,
  createIdleDraft,
  getDraftGate,
  hasActiveDraft,
  hasEditingChanges,
  reconcileDraftWithPayload,
  setComposerDraft,
  settleDraft,
  updateEditingDraft,
  type DraftSettlementFactories,
} from "../../src/fragment-thoughts/app/drafts";
import {
  applyFragmentThoughtsEvent,
  createEmptyFragmentThoughtsPayload,
  type FragmentThought,
  type FragmentThoughtVersion,
} from "../../src/fragment-thoughts/domain";

const THOUGHT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_1_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION_2_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function version(
  id: string,
  content: string,
  createdAt: string,
): FragmentThoughtVersion {
  return { id, content, createdAt };
}

function thought(
  content = "first version",
  versions: readonly FragmentThoughtVersion[] = [
    version(VERSION_1_ID, content, "2026-08-01T01:00:00.000Z"),
  ],
): FragmentThought {
  return { id: THOUGHT_ID, versions, collapsedVersionIds: [] };
}

const factories: DraftSettlementFactories = {
  createThought: (content) => thought(content),
  createVersion: (content) =>
    version(VERSION_2_ID, content, "2026-08-01T02:00:00.000Z"),
};

describe("Fragment Thoughts draft state", () => {
  it("models one idle, composer, or editing draft and exposes one mutation gate", () => {
    const idle = createIdleDraft();
    expect(hasActiveDraft(idle)).toBe(false);
    expect(getDraftGate(idle)).toEqual({ status: "ready" });

    const composer = setComposerDraft(idle, "new thought");
    expect(composer).toEqual({
      kind: "composer",
      value: "new thought",
      error: null,
    });
    expect(hasActiveDraft(composer)).toBe(true);
    expect(getDraftGate(composer)).toEqual({
      status: "blocked",
      draftKind: "composer",
    });
    expect(beginEditingDraft(composer, thought())).toBe(composer);
    expect(setComposerDraft(composer, "")).toEqual(idle);

    const editing = beginEditingDraft(idle, thought());
    expect(editing).toMatchObject({
      kind: "editing",
      thoughtId: THOUGHT_ID,
      original: "first version",
      value: "first version",
    });
    expect(setComposerDraft(editing, "ignored")).toBe(editing);
    expect(updateEditingDraft(editing, "missing", "ignored")).toBe(editing);
    const changed = updateEditingDraft(editing, THOUGHT_ID, "changed");
    expect(hasEditingChanges(changed)).toBe(true);
    expect(getDraftGate(changed)).toEqual({
      status: "blocked",
      draftKind: "editing",
    });
  });

  it("keeps manual blank drafts invalid but discards blank remote settlements", () => {
    const payload = createEmptyFragmentThoughtsPayload();
    const manualIdle = settleDraft(createIdleDraft(), payload, {
      ...factories,
      reason: "manual",
    });
    expect(manualIdle).toEqual({
      status: "invalid",
      reason: "blank",
      draft: { kind: "idle", composerError: "blank" },
    });

    const whitespace = setComposerDraft(createIdleDraft(), " \r\n\t ");
    const manualWhitespace = settleDraft(whitespace, payload, {
      ...factories,
      reason: "manual",
    });
    expect(manualWhitespace).toMatchObject({
      status: "invalid",
      reason: "blank",
      draft: { kind: "composer", error: "blank" },
    });
    const remoteWhitespace = settleDraft(whitespace, payload, {
      ...factories,
      reason: "remote-change",
    });
    expect(remoteWhitespace).toEqual({
      status: "discarded",
      reason: "blank",
      draft: createIdleDraft(),
    });
  });

  it("discards normalized no-op edits and edits whose thought disappeared", () => {
    const existing = thought("line one\nline two");
    const payload = { thoughts: [existing] };
    const editing = updateEditingDraft(
      beginEditingDraft(createIdleDraft(), existing),
      THOUGHT_ID,
      "line one\r\nline two",
    );
    expect(settleDraft(editing, payload, {
      ...factories,
      reason: "manual",
    })).toEqual({
      status: "discarded",
      reason: "unchanged",
      draft: createIdleDraft(),
    });

    expect(settleDraft(editing, createEmptyFragmentThoughtsPayload(), {
      ...factories,
      reason: "remote-change",
    })).toEqual({
      status: "discarded",
      reason: "missing-thought",
      draft: createIdleDraft(),
    });
    expect(reconcileDraftWithPayload(
      editing,
      createEmptyFragmentThoughtsPayload(),
    )).toEqual(createIdleDraft());
  });

  it("normalizes a composer event and clears it only after the event is applied", () => {
    const draft = setComposerDraft(createIdleDraft(), "line one\r\nline two");
    const result = settleDraft(draft, createEmptyFragmentThoughtsPayload(), {
      ...factories,
      reason: "remote-change",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a ready settlement.");
    expect(result.event).toMatchObject({
      type: "insert-thought",
      thought: {
        id: THOUGHT_ID,
        versions: [{ content: "line one\nline two" }],
      },
    });

    expect(completePendingDraftApplication(
      result.draft,
      result.pending,
      createEmptyFragmentThoughtsPayload(),
    )).toEqual({
      applied: false,
      draft: result.draft,
      pending: result.pending,
    });

    const applied = applyFragmentThoughtsEvent(
      createEmptyFragmentThoughtsPayload(),
      result.event,
    );
    expect(completePendingDraftApplication(
      result.draft,
      result.pending,
      applied,
    )).toEqual({
      applied: true,
      draft: createIdleDraft(),
      pending: null,
    });

    const newerDraft = setComposerDraft(result.draft, "typed while pending");
    expect(completePendingDraftApplication(
      newerDraft,
      result.pending,
      applied,
    )).toEqual({
      applied: true,
      draft: newerDraft,
      pending: null,
    });
  });

  it("uses the same pending-application cleanup for a completed edit", () => {
    const existing = thought();
    const payload = { thoughts: [existing] };
    const draft = updateEditingDraft(
      beginEditingDraft(createIdleDraft(), existing),
      THOUGHT_ID,
      "second version",
    );
    const result = settleDraft(draft, payload, {
      ...factories,
      reason: "manual",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a ready settlement.");
    expect(result.event).toEqual({
      type: "append-version",
      thoughtId: THOUGHT_ID,
      version: version(
        VERSION_2_ID,
        "second version",
        "2026-08-01T02:00:00.000Z",
      ),
      collapsed: false,
    });

    const applied = applyFragmentThoughtsEvent(payload, result.event);
    expect(completePendingDraftApplication(
      result.draft,
      result.pending,
      applied,
    )).toEqual({
      applied: true,
      draft: createIdleDraft(),
      pending: null,
    });
  });
});
