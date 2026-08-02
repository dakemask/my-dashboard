import {
  AddUser,
  CheckSmall,
  CloseSmall,
} from "@icon-park/svg";

import {
  createIconOnlyButton,
  createIconParkIcon,
} from "../../shared";
import type {
  DashboardAccount,
  DashboardProfileState,
} from "../../shared/profiles";
import type { FirstAccountDirection } from "../accountSetup";

export interface AccountCredentialsInput {
  readonly username: string;
  readonly token: string;
}

export interface AccountSetupUiHooks {
  setBusyStage(message: string): void;
  chooseFirstAccountDirection(): Promise<FirstAccountDirection>;
}

export interface AccountSettingsDialogOptions {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly getProfileState: () => DashboardProfileState;
  readonly selectAccount: (accountId: string) => void;
  readonly addAccount: (
    credentials: AccountCredentialsInput,
    hooks: AccountSetupUiHooks,
  ) => Promise<void>;
  readonly describeError: (error: unknown) => string;
  readonly onProfileChanged: () => HTMLElement | null;
  readonly onClosed?: () => void;
}

type DialogState =
  | { readonly kind: "overview" }
  | { readonly kind: "add-form"; readonly username: string }
  | { readonly kind: "direction-choice" }
  | { readonly kind: "busy"; readonly message: string }
  | { readonly kind: "error"; readonly username: string; readonly message: string };

interface DirectionChoice {
  resolve(direction: FirstAccountDirection): void;
  reject(error: unknown): void;
}

/** A single native dialog whose content is driven by one explicit state machine. */
export class AccountSettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly content: HTMLDivElement;
  private state: DialogState = { kind: "overview" };
  private trigger: HTMLElement | null = null;
  private tokenInput: HTMLInputElement | null = null;
  private directionChoice: DirectionChoice | null = null;
  private profileChanged = false;
  private closed = false;

  constructor(private readonly options: AccountSettingsDialogOptions) {
    this.dialog = options.document.createElement("dialog");
    this.dialog.className = "account-settings-dialog";
    this.dialog.setAttribute("aria-labelledby", "account-settings-title");

    const header = options.document.createElement("header");
    header.className = "settings-dialog-header";
    this.title = options.document.createElement("h2");
    this.title.id = "account-settings-title";
    this.title.textContent = "账户设置";
    this.closeButton = createIconOnlyButton(
      options.document,
      CloseSmall,
      "关闭账户设置",
      {
        classNames: "icon-button",
        iconClassNames: "button-icon",
      },
    );
    this.closeButton.addEventListener("click", () => this.requestClose());
    header.append(this.title, this.closeButton);

    this.content = options.document.createElement("div");
    this.content.className = "settings-dialog-content";
    this.dialog.append(header, this.content);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (this.canClose()) this.requestClose();
    });
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog && this.canClose()) this.requestClose();
    });
    this.dialog.addEventListener("close", () => this.finishClose());
  }

  open(trigger: HTMLElement): void {
    if (this.closed) throw new Error("Closed account settings cannot be reopened.");
    this.trigger = trigger;
    this.options.host.append(this.dialog);
    this.render({ kind: "overview" });
    this.dialog.showModal();
  }

  focus(): void {
    this.dialog.focus();
  }

  private render(state: DialogState): void {
    if (this.closed) return;
    this.clearTokenInput();
    this.state = state;
    this.dialog.dataset.state = state.kind;
    const busy = state.kind === "busy";
    if (busy) this.dialog.setAttribute("aria-busy", "true");
    else this.dialog.removeAttribute("aria-busy");
    this.closeButton.disabled = busy;
    this.content.replaceChildren();

    switch (state.kind) {
      case "overview":
        this.renderOverview();
        break;
      case "add-form":
        this.renderAccountForm(state.username);
        break;
      case "direction-choice":
        this.renderDirectionChoice();
        break;
      case "busy":
        this.renderBusy(state.message);
        break;
      case "error":
        this.renderAccountForm(state.username, state.message);
        break;
    }
  }

  private renderOverview(): void {
    this.title.textContent = "账户设置";
    const profile = this.options.getProfileState();
    const intro = this.options.document.createElement("p");
    intro.className = "settings-intro";
    intro.textContent = profile.mode === "local"
      ? "当前为本地模式。添加首个账户后，整个仪表盘将转为账户模式。"
      : "选择一个账户，之后打开的模块将使用该账户的本机缓存和云端数据。";
    this.content.append(intro);

    if (profile.mode === "accounts") {
      const list = this.options.document.createElement("ul");
      list.className = "account-list";
      for (const account of profile.accounts) {
        const item = this.options.document.createElement("li");
        item.append(this.createAccountButton(
          account,
          account.id === profile.activeAccountId,
        ));
        list.append(item);
      }
      this.content.append(list);
    }

    const addButton = this.options.document.createElement("button");
    addButton.type = "button";
    addButton.className = "add-account-button";
    addButton.append(
      createIconParkIcon(this.options.document, AddUser, {
        classNames: "button-icon",
      }),
      this.options.document.createTextNode("添加账户"),
    );
    addButton.addEventListener("click", () => {
      this.render({ kind: "add-form", username: "" });
      this.deferFocus("input[name=\"username\"]");
    });
    this.content.append(addButton);
  }

  private createAccountButton(
    account: DashboardAccount,
    active: boolean,
  ): HTMLButtonElement {
    const button = this.options.document.createElement("button");
    button.type = "button";
    button.className = "account-option";
    button.dataset.active = String(active);
    const name = this.options.document.createElement("span");
    name.textContent = account.username;
    const status = this.options.document.createElement("span");
    status.className = "account-option-status";
    if (active) {
      status.append(
        createIconParkIcon(this.options.document, CheckSmall, {
          classNames: "button-icon",
        }),
        this.options.document.createTextNode("当前"),
      );
    } else {
      status.textContent = "选择";
    }
    button.append(name, status);
    button.disabled = active;
    if (!active) {
      button.addEventListener("click", () => {
        this.options.selectAccount(account.id);
        this.profileChanged = true;
        this.requestClose();
      });
    }
    return button;
  }

  private renderAccountForm(usernameValue: string, errorMessage?: string): void {
    this.title.textContent = errorMessage ? "重新添加账户" : "添加账户";
    const profile = this.options.getProfileState();
    const description = this.options.document.createElement("p");
    description.className = "settings-intro";
    description.textContent = profile.mode === "local"
      ? "验证成功后，本地模式将结束，并把整个仪表盘接入这个账户。"
      : "验证成功后将切换到新账户；已有账户的数据不会被修改。";

    const form = this.options.document.createElement("form");
    form.className = "account-form";
    const username = this.createField("GitHub 用户名", "text", "username");
    username.input.autocomplete = "username";
    username.input.value = usernameValue;
    const token = this.createField("GitHub token", "password", "token");
    token.input.autocomplete = "current-password";
    this.tokenInput = token.input;

    if (errorMessage) {
      const error = this.options.document.createElement("p");
      error.className = "account-form-error";
      error.setAttribute("role", "alert");
      error.textContent = errorMessage;
      form.append(error);
    }

    const actions = this.options.document.createElement("div");
    actions.className = "account-form-actions";
    const cancel = this.options.document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-button";
    cancel.textContent = "返回";
    cancel.addEventListener("click", () => {
      this.clearTokenInput();
      this.render({ kind: "overview" });
    });
    const submit = this.options.document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-button";
    submit.textContent = "验证并添加";
    actions.append(cancel, submit);
    form.append(username.label, token.label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const credentials = {
        username: username.input.value,
        token: token.input.value,
      };
      this.clearTokenInput();
      this.render({ kind: "busy", message: "正在验证 GitHub 凭据…" });
      void this.options.addAccount(credentials, {
        setBusyStage: (message) => {
          this.render({ kind: "busy", message });
        },
        chooseFirstAccountDirection: () => this.chooseDirection(),
      }).then(() => {
        if (this.closed) return;
        this.profileChanged = true;
        this.requestClose(true);
      }).catch((error: unknown) => {
        if (this.closed) return;
        this.render({
          kind: "error",
          username: credentials.username,
          message: this.options.describeError(error),
        });
        this.deferFocus("input[name=\"token\"]");
      });
    });

    this.content.append(description, form);
  }

  private renderDirectionChoice(): void {
    this.title.textContent = "选择整个仪表盘的数据";
    const message = this.options.document.createElement("p");
    message.className = "settings-intro";
    message.textContent =
      "本地和云端都已有数据。请选择保留方向；该选择会统一应用于全部模块。";
    const hint = this.options.document.createElement("p");
    hint.className = "direction-choice-hint";
    hint.textContent = "覆盖操作无法在浏览器中自动回滚。";

    const actions = this.options.document.createElement("div");
    actions.className = "first-account-actions";
    const cancel = this.options.document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      this.rejectDirectionChoice(new AccountSetupCancelledError());
    });
    const localWins = this.options.document.createElement("button");
    localWins.type = "button";
    localWins.className = "primary-button";
    localWins.textContent = "本地覆盖云端";
    localWins.addEventListener("click", () => {
      this.resolveDirectionChoice("local-wins");
    });
    const cloudWins = this.options.document.createElement("button");
    cloudWins.type = "button";
    cloudWins.className = "danger-button";
    cloudWins.textContent = "云端覆盖本地";
    cloudWins.addEventListener("click", () => {
      this.resolveDirectionChoice("cloud-wins");
    });
    actions.append(cancel, localWins, cloudWins);
    this.content.append(message, hint, actions);
    this.deferFocus(".first-account-actions .secondary-button");
  }

  private renderBusy(message: string): void {
    this.title.textContent = "正在添加账户";
    const panel = this.options.document.createElement("div");
    panel.className = "account-setup-progress";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    const spinner = this.options.document.createElement("span");
    spinner.className = "account-setup-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = this.options.document.createElement("p");
    text.textContent = message;
    panel.append(spinner, text);
    this.content.append(panel);
  }

  private chooseDirection(): Promise<FirstAccountDirection> {
    if (this.closed) return Promise.reject(new AccountSetupCancelledError());
    if (this.directionChoice) {
      return Promise.reject(new Error("A direction choice is already pending."));
    }
    this.render({ kind: "direction-choice" });
    return new Promise((resolve, reject) => {
      this.directionChoice = { resolve, reject };
    });
  }

  private resolveDirectionChoice(direction: FirstAccountDirection): void {
    const choice = this.directionChoice;
    this.directionChoice = null;
    if (!choice) return;
    this.render({ kind: "busy", message: "正在准备全部模块…" });
    choice.resolve(direction);
  }

  private rejectDirectionChoice(error: unknown): void {
    const choice = this.directionChoice;
    this.directionChoice = null;
    if (!choice) return;
    choice.reject(error);
  }

  private requestClose(force = false): void {
    if (!force && !this.canClose()) return;
    this.clearTokenInput();
    this.rejectDirectionChoice(new AccountSetupCancelledError());
    this.dialog.close();
  }

  private canClose(): boolean {
    return this.state.kind !== "busy";
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTokenInput();
    this.rejectDirectionChoice(new AccountSetupCancelledError());
    this.dialog.remove();
    this.options.onClosed?.();
    const replacementTrigger = this.profileChanged
      ? this.options.onProfileChanged()
      : null;
    const focusTarget = replacementTrigger ?? this.trigger;
    if (focusTarget?.isConnected) focusTarget.focus();
  }

  private clearTokenInput(): void {
    if (this.tokenInput) this.tokenInput.value = "";
    this.tokenInput = null;
  }

  private createField(
    text: string,
    type: HTMLInputElement["type"],
    name: string,
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = this.options.document.createElement("label");
    label.className = "account-field";
    const title = this.options.document.createElement("span");
    title.textContent = text;
    const input = this.options.document.createElement("input");
    input.type = type;
    input.name = name;
    input.required = true;
    label.append(title, input);
    return { label, input };
  }

  private deferFocus(selector: string): void {
    queueMicrotask(() => {
      if (this.closed) return;
      this.content.querySelector<HTMLElement>(selector)?.focus();
    });
  }
}

export class AccountSetupCancelledError extends Error {
  constructor() {
    super("Account setup was cancelled.");
    this.name = "AccountSetupCancelledError";
  }
}
