// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ThoughtList } from "../../src/fragment-thoughts/ui/thoughtList";
import type {
  FragmentThoughtsShellCallbacks,
  ThoughtCardView,
} from "../../src/fragment-thoughts/ui/types";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ThoughtList keyed rendering", () => {
  it("reuses each card and textarea while filtering and reordering", () => {
    const list = createList();
    const first = view("first", "第一条");
    const second = view("second", "第二条");
    list.render([first, second]);
    const firstCard = card(list, "first");
    const firstEditor = editor(firstCard);

    list.render([second], "没有匹配项", ["first", "second"]);
    expect(firstCard.isConnected).toBe(false);
    list.render([second, first], undefined, ["first", "second"]);

    expect(card(list, "first")).toBe(firstCard);
    expect(editor(card(list, "first"))).toBe(firstEditor);
    expect([...list.root.children].map((item) => (item as HTMLElement).dataset.thoughtId))
      .toEqual(["second", "first"]);
  });

  it("removes deleted ids from its keyed cache", () => {
    const list = createList();
    list.render([view("first", "旧内容")]);
    const removedEditor = editor(card(list, "first"));
    list.render([], undefined, []);
    list.render([view("first", "新内容")]);
    expect(editor(card(list, "first"))).not.toBe(removedEditor);
  });
});

describe("ThoughtList editor continuity", () => {
  it("uses one textarea for read and edit states and only writes changed values", () => {
    const list = createList();
    list.render([view("first", "正文")]);
    const text = editor(card(list, "first"));
    expect(text.readOnly).toBe(true);

    list.render([view("first", "正文", { editing: true, editDraft: "正文" })]);
    expect(editor(card(list, "first"))).toBe(text);
    expect(text.readOnly).toBe(false);
    text.value = "用户输入";
    list.render([view("first", "正文", { editing: true, editDraft: "用户输入" })]);
    expect(text.value).toBe("用户输入");
  });

  it("does not overwrite the textarea during IME composition", () => {
    const callbacks = { onEditInput: vi.fn() } satisfies FragmentThoughtsShellCallbacks;
    const list = createList(callbacks);
    list.render([view("first", "正文", { editing: true, editDraft: "正文" })]);
    const text = editor(card(list, "first"));
    text.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    text.value = "中文输入中";

    list.render([view("first", "正文", { editing: true, editDraft: "过时草稿" })]);
    expect(text.value).toBe("中文输入中");
    text.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(callbacks.onEditInput).toHaveBeenLastCalledWith("first", "中文输入中");
  });
});

describe("ThoughtList presentation and callbacks", () => {
  it("renders the exact structured highlight ranges", () => {
    const list = createList();
    list.render([view("first", "Abc abc", {
      highlightQuery: "not-used",
      highlightRanges: [{ start: 4, end: 7 }],
    })]);
    const highlight = card(list, "first").querySelector(".ft-thought-highlight")!;
    expect(highlight.textContent).toBe("Abc abc");
    expect(highlight.querySelector("mark")?.textContent).toBe("abc");
  });

  it("reports semantic edit and action callbacks", () => {
    const callbacks = {
      onEditInput: vi.fn(),
      onSaveEdit: vi.fn(),
      onDeleteThought: vi.fn(),
    } satisfies FragmentThoughtsShellCallbacks;
    const list = createList(callbacks);
    list.render([view("first", "正文", { editing: true, editDraft: "正文" })]);
    const text = editor(card(list, "first"));
    text.value = "修改";
    text.dispatchEvent(new InputEvent("input", { bubbles: true }));
    card(list, "first").querySelector<HTMLButtonElement>('[data-action="save-edit"]')!.click();
    expect(callbacks.onEditInput).toHaveBeenCalledWith("first", "修改");
    expect(callbacks.onSaveEdit).toHaveBeenCalledWith("first", "修改");

    list.render([view("first", "正文")]);
    card(list, "first").querySelector<HTMLButtonElement>('[data-action="delete-thought"]')!.click();
    expect(callbacks.onDeleteThought).toHaveBeenCalledWith("first");
  });

  it("locks read-state mutations without disabling edit save or cancel", () => {
    const list = createList();
    list.render([view("first", "正文")]);
    list.setMutationLocked(true);
    expect(action(list, "first", "edit-thought").disabled).toBe(true);
    expect(action(list, "first", "delete-thought").disabled).toBe(true);

    list.render([view("first", "正文", { editing: true, editDraft: "正文" })]);
    expect(action(list, "first", "save-edit").disabled).toBe(false);
    expect(action(list, "first", "cancel-edit").disabled).toBe(false);
  });
});

function createList(callbacks: FragmentThoughtsShellCallbacks = {}): ThoughtList {
  const list = new ThoughtList(document, callbacks);
  document.body.append(list.root, list.empty);
  return list;
}

function view(
  id: string,
  content: string,
  overrides: Partial<ThoughtCardView> = {},
): ThoughtCardView {
  return {
    id,
    content,
    modifiedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function card(list: ThoughtList, id: string): HTMLElement {
  const result = list.root.querySelector<HTMLElement>(`[data-thought-id="${id}"]`);
  if (!result) throw new Error(`Missing card ${id}`);
  return result;
}

function editor(cardElement: HTMLElement): HTMLTextAreaElement {
  const result = cardElement.querySelector<HTMLTextAreaElement>("textarea");
  if (!result) throw new Error("Missing editor");
  return result;
}

function action(
  list: ThoughtList,
  id: string,
  name: string,
): HTMLButtonElement {
  const result = card(list, id).querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
  if (!result) throw new Error(`Missing action ${name}`);
  return result;
}
