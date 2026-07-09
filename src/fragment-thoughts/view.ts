import { queryRequired } from "../shared/dom";
import type { PrivateDataSettings } from "../shared/privateData/types";
import type { FragmentThought } from "./types";

export interface FragmentThoughtsElements {
  settingsBtn: HTMLButtonElement;
  settingsPanel: HTMLElement;
  ownerInput: HTMLInputElement;
  repoInput: HTMLInputElement;
  branchInput: HTMLInputElement;
  pathInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
  saveSettingsBtn: HTMLButtonElement;
  clearSettingsBtn: HTMLButtonElement;
  thoughtInput: HTMLTextAreaElement;
  tagInput: HTMLInputElement;
  addBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  status: HTMLElement;
  list: HTMLElement;
  syncOverlay: HTMLElement;
}

export function getFragmentThoughtsElements(): FragmentThoughtsElements {
  return {
    settingsBtn: queryRequired("#settingsBtn"),
    settingsPanel: queryRequired("#settingsPanel"),
    ownerInput: queryRequired("#ownerInput"),
    repoInput: queryRequired("#repoInput"),
    branchInput: queryRequired("#branchInput"),
    pathInput: queryRequired("#pathInput"),
    tokenInput: queryRequired("#tokenInput"),
    saveSettingsBtn: queryRequired("#saveSettingsBtn"),
    clearSettingsBtn: queryRequired("#clearSettingsBtn"),
    thoughtInput: queryRequired("#thoughtInput"),
    tagInput: queryRequired("#tagInput"),
    addBtn: queryRequired("#addBtn"),
    refreshBtn: queryRequired("#refreshBtn"),
    searchInput: queryRequired("#searchInput"),
    status: queryRequired("#status"),
    list: queryRequired("#list"),
    syncOverlay: queryRequired("#syncOverlay"),
  };
}

export function setStatus(elements: FragmentThoughtsElements, message = ""): void {
  elements.status.textContent = message;
}

export function setSyncOverlayVisible(elements: FragmentThoughtsElements, visible: boolean): void {
  elements.syncOverlay.classList.toggle("hidden", !visible);
  elements.syncOverlay.setAttribute("aria-hidden", String(!visible));
}

export function fillSettingsForm(elements: FragmentThoughtsElements, settings: PrivateDataSettings): void {
  elements.ownerInput.value = settings.owner;
  elements.repoInput.value = settings.repo;
  elements.branchInput.value = settings.branch;
  elements.pathInput.value = settings.path;
  elements.tokenInput.value = settings.token;
}

export function readSettingsForm(elements: FragmentThoughtsElements): PrivateDataSettings {
  return {
    owner: elements.ownerInput.value.trim(),
    repo: elements.repoInput.value.trim(),
    branch: elements.branchInput.value.trim(),
    path: elements.pathInput.value.trim(),
    token: elements.tokenInput.value.trim(),
  };
}

export function clearComposer(elements: FragmentThoughtsElements): void {
  elements.thoughtInput.value = "";
  elements.tagInput.value = "";
}

export function renderFragmentThoughts(
  elements: FragmentThoughtsElements,
  fragmentThoughts: FragmentThought[],
  onDelete: (id: string) => void,
): void {
  elements.list.replaceChildren();

  if (fragmentThoughts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有匹配的想法。";
    elements.list.append(empty);
    return;
  }

  const fragmentThoughtElements = fragmentThoughts.map((fragmentThought) =>
    createFragmentThoughtElement(fragmentThought, onDelete),
  );
  elements.list.append(...fragmentThoughtElements);
}

function createFragmentThoughtElement(fragmentThought: FragmentThought, onDelete: (id: string) => void): HTMLElement {
  const article = document.createElement("article");
  article.className = "note";

  const content = document.createElement("div");
  content.className = "note-content";
  content.textContent = fragmentThought.content;

  const meta = document.createElement("div");
  meta.className = "note-meta";

  const tagContainer = document.createElement("div");
  if (fragmentThought.tags.length > 0) {
    const tags = document.createElement("div");
    tags.className = "tags";
    tags.append(...fragmentThought.tags.map(createTagElement));
    tagContainer.append(tags);
  }

  const actions = document.createElement("div");
  actions.textContent = formatTime(fragmentThought.createdAt);

  const deleteButton = document.createElement("button");
  deleteButton.className = "ghost danger";
  deleteButton.type = "button";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => onDelete(fragmentThought.id));

  actions.append(" ", deleteButton);
  meta.append(tagContainer, actions);
  article.append(content, meta);

  return article;
}

function createTagElement(tag: string): HTMLElement {
  const tagElement = document.createElement("span");
  tagElement.className = "tag";
  tagElement.textContent = tag;

  return tagElement;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
