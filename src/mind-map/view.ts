import { queryRequired } from "../shared/dom";
import type { PrivateDataSettings } from "../shared/privateData/types";

export interface MindMapElements {
  settingsBtn: HTMLButtonElement;
  settingsPanel: HTMLElement;
  ownerInput: HTMLInputElement;
  repoInput: HTMLInputElement;
  branchInput: HTMLInputElement;
  pathInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
  saveSettingsBtn: HTMLButtonElement;
  clearSettingsBtn: HTMLButtonElement;
  addNodeBtn: HTMLButtonElement;
  connectBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  status: HTMLElement;
  canvasHost: HTMLDivElement;
  contextMenu: HTMLElement;
  contextDeleteBtn: HTMLButtonElement;
}

export function getMindMapElements(): MindMapElements {
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
    addNodeBtn: queryRequired("#addNodeBtn"),
    connectBtn: queryRequired("#connectBtn"),
    saveBtn: queryRequired("#saveBtn"),
    refreshBtn: queryRequired("#refreshBtn"),
    resetBtn: queryRequired("#resetBtn"),
    status: queryRequired("#status"),
    canvasHost: queryRequired("#canvasHost"),
    contextMenu: queryRequired("#contextMenu"),
    contextDeleteBtn: queryRequired("#contextDeleteBtn"),
  };
}

export function setStatus(elements: MindMapElements, message = ""): void {
  elements.status.textContent = message;
}

export function fillSettingsForm(elements: MindMapElements, settings: PrivateDataSettings): void {
  elements.ownerInput.value = settings.owner;
  elements.repoInput.value = settings.repo;
  elements.branchInput.value = settings.branch;
  elements.pathInput.value = settings.path;
  elements.tokenInput.value = settings.token;
}

export function readSettingsForm(elements: MindMapElements): PrivateDataSettings {
  return {
    owner: elements.ownerInput.value.trim(),
    repo: elements.repoInput.value.trim(),
    branch: elements.branchInput.value.trim(),
    path: elements.pathInput.value.trim(),
    token: elements.tokenInput.value.trim(),
  };
}

export function setConnectMode(elements: MindMapElements, enabled: boolean): void {
  elements.connectBtn.classList.toggle("active", enabled);
  elements.connectBtn.setAttribute("aria-pressed", String(enabled));
}

export function showContextMenu(elements: MindMapElements, x: number, y: number): void {
  elements.contextMenu.classList.remove("hidden");
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;

  const bounds = elements.contextMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - bounds.width - 8);
  const top = Math.min(y, window.innerHeight - bounds.height - 8);

  elements.contextMenu.style.left = `${Math.max(8, left)}px`;
  elements.contextMenu.style.top = `${Math.max(8, top)}px`;
}

export function hideContextMenu(elements: MindMapElements): void {
  elements.contextMenu.classList.add("hidden");
}
