import {
  AddOne,
  Calendar,
  CloseSmall,
  Home,
} from "@icon-park/svg";
import { createTodoIcon } from "./icons";

export interface TodosShellElements {
  readonly root: HTMLElement;
  readonly homeLink: HTMLAnchorElement;
  readonly syncMount: HTMLElement;
  readonly retrySaveButton: HTMLButtonElement;
  readonly saveFailure: HTMLElement;
  readonly addTodoButton: HTMLButtonElement;
  readonly openRulesButton: HTMLButtonElement;
  readonly todoList: HTMLElement;
  readonly ruleList: HTMLElement;
  readonly toast: HTMLElement;
}

export class TodosShell {
  readonly elements: TodosShellElements;
  readonly document: Document;
  #toastTimer: number | null = null;

  constructor(appRoot: HTMLElement) {
    this.document = appRoot.ownerDocument;
    const root = this.document.createElement("main");
    root.className = "todos-app";

    const header = this.document.createElement("header");
    header.className = "todos-header";
    const identity = this.document.createElement("div");
    identity.className = "todos-identity";
    const homeLink = this.document.createElement("a");
    homeLink.className = "todos-icon-button";
    homeLink.href = new URL(import.meta.env.BASE_URL, this.document.location.href).href;
    homeLink.title = "返回首页";
    homeLink.setAttribute("aria-label", "返回首页");
    homeLink.append(createTodoIcon(this.document, Home));
    const copy = this.document.createElement("div");
    const title = this.document.createElement("h1");
    title.textContent = "待办";
    copy.append(title);
    identity.append(homeLink, copy);

    const headerActions = this.document.createElement("div");
    headerActions.className = "todos-header-actions";
    const syncMount = this.document.createElement("div");
    syncMount.className = "todos-sync-mount";
    headerActions.append(syncMount);
    header.append(identity, headerActions);

    const saveFailure = this.document.createElement("div");
    saveFailure.className = "todos-save-failure";
    saveFailure.hidden = true;
    saveFailure.setAttribute("role", "alert");
    const failureText = this.document.createElement("span");
    failureText.textContent = "自动保存失败，当前页面内容仍然保留。";
    const retrySaveButton = textButton(this.document, "重试保存", "todos-button subtle");
    saveFailure.append(failureText, retrySaveButton);

    const content = this.document.createElement("div");
    content.className = "todos-content";
    const commandBar = this.document.createElement("div");
    commandBar.className = "todos-command-bar";
    const addTodoButton = textButton(this.document, "添加待办", "todos-button primary compact add-todo", AddOne);
    addTodoButton.title = "添加待办";
    addTodoButton.setAttribute("aria-label", "添加待办");
    const openRulesButton = textButton(this.document, "周期待办", "todos-button subtle compact rules-toggle", Calendar);
    openRulesButton.title = "打开周期待办模版";
    openRulesButton.setAttribute("aria-label", "打开周期待办模版");
    openRulesButton.setAttribute("aria-haspopup", "dialog");
    commandBar.append(addTodoButton, openRulesButton);

    const todoSection = sectionShell(this.document, "待办事项");
    const todoList = this.document.createElement("div");
    todoList.className = "todos-list";
    todoSection.section.append(todoList);

    const ruleList = this.document.createElement("div");
    ruleList.className = "todos-rule-list";
    content.append(commandBar, todoSection.section);

    const toast = this.document.createElement("div");
    toast.className = "todos-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.hidden = true;
    root.append(header, saveFailure, content, toast);
    appRoot.replaceChildren(root);
    this.elements = {
      root, homeLink, syncMount, retrySaveButton, saveFailure,
      addTodoButton, todoList, ruleList, toast, openRulesButton,
    };
  }

  showMessage(message: string, tone: "normal" | "success" | "error" = "normal"): void {
    if (this.#toastTimer !== null) window.clearTimeout(this.#toastTimer);
    this.elements.toast.textContent = message;
    this.elements.toast.dataset.tone = tone;
    this.elements.toast.hidden = false;
    this.#toastTimer = window.setTimeout(() => {
      this.elements.toast.hidden = true;
      this.#toastTimer = null;
    }, 4200);
  }

  setSaveFailure(failed: boolean): void {
    this.elements.saveFailure.hidden = !failed;
  }

  dispose(): void {
    if (this.#toastTimer !== null) window.clearTimeout(this.#toastTimer);
    this.elements.root.remove();
  }
}

function sectionShell(document: Document, titleText: string): {
  section: HTMLElement;
  heading: HTMLElement;
} {
  const section = document.createElement("section");
  section.className = "todos-section";
  const heading = document.createElement("div");
  heading.className = "todos-section-heading";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = titleText;
  copy.append(title);
  heading.append(copy);
  section.append(heading);
  return { section, heading };
}

export function iconButton(
  document: Document,
  icon: typeof Home,
  label: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "todos-icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(createTodoIcon(document, icon));
  return button;
}

export function textButton(
  document: Document,
  label: string,
  className: string,
  icon?: typeof Home,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  if (icon) button.append(createTodoIcon(document, icon));
  button.append(document.createTextNode(label));
  return button;
}

export function closeButton(document: Document, label: string): HTMLButtonElement {
  return iconButton(document, CloseSmall, label);
}
