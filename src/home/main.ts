import {
  AddUser,
  CheckSmall,
  CloseSmall,
  Config,
} from "@icon-park/svg";
import {
  AuthenticationError,
  authenticateGitHubCredentials,
} from "../shared/auth";
import {
  createDashboardProfileStore,
  type DashboardAccount,
} from "../shared/profiles";
import { queryRequired } from "../shared/dom";
import {
  bindFirstAccount,
  clearLocalProfile,
  inspectFirstAccount,
  type FirstAccountDirection,
} from "./accountSetup";
import { dashboardModules } from "./modules";

const app = queryRequired<HTMLDivElement>("#app");
const profileStore = createDashboardProfileStore();

renderHome();

function renderHome(): void {
  const state = profileStore.getState();
  const shell = document.createElement("main");
  shell.className = "shell";

  const header = document.createElement("header");
  header.className = "home-header";
  const heading = document.createElement("div");
  heading.className = "home-heading";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "My Dashboard";

  const title = document.createElement("h1");
  title.textContent = "功能入口";

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "选择要打开的模块。";
  heading.append(eyebrow, title, subtitle);

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "settings-button";
  settingsButton.append(createIcon(Config, "settings-button-icon"));
  settingsButton.setAttribute("aria-label", "账户设置");
  settingsButton.title = "账户设置";
  settingsButton.addEventListener("click", () => {
    mountSettingsDialog(shell);
  });
  header.append(heading, settingsButton);

  const mode = document.createElement("p");
  mode.className = "home-mode";
  if (state.mode === "local") {
    mode.textContent = "本地模式 · 数据仅保存在此浏览器";
  } else {
    const active = state.accounts.find((account) => account.id === state.activeAccountId);
    mode.textContent = active ? `当前账户 · ${active.username}` : "账户模式";
  }

  const section = document.createElement("section");
  section.className = "module-section";
  section.setAttribute("aria-label", "功能模块");

  const moduleList = document.createElement("div");
  moduleList.className = "module-list";
  section.append(moduleList);
  shell.append(header, mode, section);
  app.replaceChildren(shell);

  if (dashboardModules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无可用模块。";
    moduleList.append(empty);
    return;
  }

  const links = dashboardModules.map((module) => {
    const link = document.createElement("a");
    link.className = "module-link";
    link.href = module.href;

    const text = document.createElement("span");
    const moduleTitle = document.createElement("span");
    moduleTitle.className = "module-title";
    moduleTitle.textContent = module.title;

    const description = document.createElement("span");
    description.className = "module-description";
    description.textContent = module.description;

    const action = document.createElement("span");
    action.className = "module-action";
    action.textContent = "进入";

    text.append(moduleTitle, description);
    link.append(text, action);
    return link;
  });

  moduleList.append(...links);
}

function mountSettingsDialog(host: HTMLElement): void {
  const existing = host.querySelector<HTMLDialogElement>(".account-settings-dialog");
  if (existing) {
    existing.showModal();
    return;
  }

  const dialog = document.createElement("dialog");
  dialog.className = "account-settings-dialog";
  dialog.setAttribute("aria-labelledby", "account-settings-title");

  const header = document.createElement("header");
  header.className = "settings-dialog-header";
  const title = document.createElement("h2");
  title.id = "account-settings-title";
  title.textContent = "账户设置";
  const closeButton = createIconButton("关闭账户设置", CloseSmall);
  closeButton.addEventListener("click", () => dialog.close());
  header.append(title, closeButton);

  const content = document.createElement("div");
  content.className = "settings-dialog-content";
  dialog.append(header, content);
  host.append(dialog);

  dialog.addEventListener("close", () => {
    dialog.remove();
  });
  renderSettingsContent(content, dialog);
  dialog.showModal();
}

function renderSettingsContent(
  content: HTMLElement,
  dialog: HTMLDialogElement,
): void {
  const state = profileStore.getState();
  content.replaceChildren();

  const intro = document.createElement("p");
  intro.className = "settings-intro";
  intro.textContent = state.mode === "local"
    ? "当前为本地模式。添加首个账户后，整个仪表盘将转为账户模式。"
    : "选择一个账户，之后打开的模块将使用该账户的本机缓存和云端数据。";
  content.append(intro);

  if (state.mode === "accounts") {
    const list = document.createElement("div");
    list.className = "account-list";
    list.setAttribute("role", "list");
    for (const account of state.accounts) {
      list.append(createAccountButton(account, account.id === state.activeAccountId, dialog));
    }
    content.append(list);
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "add-account-button";
  addButton.append(createIcon(AddUser, "button-icon"), document.createTextNode("添加账户"));
  content.append(addButton);
  addButton.addEventListener("click", () => {
    renderAddAccountForm(content, dialog);
  });
}

function createAccountButton(
  account: DashboardAccount,
  active: boolean,
  dialog: HTMLDialogElement,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "account-option";
  button.dataset.active = String(active);
  button.setAttribute("role", "listitem");
  const name = document.createElement("span");
  name.textContent = account.username;
  const status = document.createElement("span");
  status.className = "account-option-status";
  if (active) {
    status.append(createIcon(CheckSmall, "button-icon"), document.createTextNode("当前"));
  } else {
    status.textContent = "选择";
  }
  button.append(name, status);
  button.disabled = active;
  if (!active) {
    button.addEventListener("click", () => {
      profileStore.selectAccount(account.id);
      dialog.close();
      renderHome();
    });
  }
  return button;
}

function renderAddAccountForm(
  content: HTMLElement,
  dialog: HTMLDialogElement,
): void {
  content.replaceChildren();
  const state = profileStore.getState();
  const description = document.createElement("p");
  description.className = "settings-intro";
  description.textContent = state.mode === "local"
    ? "验证成功后，本地模式将结束，并把整个仪表盘接入这个账户。"
    : "验证成功后将切换到新账户；已有账户的数据不会被修改。";

  const form = document.createElement("form");
  form.className = "account-form";
  const username = createField("GitHub 用户名", "text", "username");
  username.input.autocomplete = "username";
  const token = createField("GitHub token", "password", "token");
  token.input.autocomplete = "current-password";

  const error = document.createElement("p");
  error.className = "account-form-error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "account-form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-button";
  cancel.textContent = "返回";
  cancel.addEventListener("click", () => renderSettingsContent(content, dialog));
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button";
  submit.textContent = "验证并添加";
  actions.append(cancel, submit);
  form.append(username.label, token.label, error, actions);
  content.append(description, form);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    cancel.disabled = true;
    username.input.disabled = true;
    token.input.disabled = true;
    error.hidden = true;
    submit.textContent = "正在验证…";
    void addAccount(
      username.input.value,
      token.input.value,
      dialog,
    ).catch((caught: unknown) => {
      error.textContent = caught instanceof AuthenticationError
        ? caught.message
        : caught instanceof AccountSetupCancelledError
          ? "已取消添加账户，本地数据没有被修改。"
          : "添加账户失败，本地数据和已有账户均未修改。";
      error.hidden = false;
      submit.disabled = false;
      cancel.disabled = false;
      username.input.disabled = false;
      token.input.disabled = false;
      token.input.value = "";
      submit.textContent = "验证并添加";
    });
  });
}

async function addAccount(
  username: string,
  token: string,
  settingsDialog: HTMLDialogElement,
): Promise<void> {
  const session = await authenticateGitHubCredentials({ username, token });
  const state = profileStore.getState();
  const profileId = `github-${session.credentials.username.toLocaleLowerCase("en-US")}`;
  if (state.mode === "local") {
    const inspection = await inspectFirstAccount(session);
    const direction = inspection.needsChoice
      ? await chooseFirstAccountDirection(settingsDialog)
      : inspection.suggestedDirection;
    await bindFirstAccount(session, profileId, direction);
  }
  profileStore.addAccount(session, profileId);
  if (state.mode === "local") {
    await clearLocalProfile();
  }
  settingsDialog.close();
  renderHome();
}

function chooseFirstAccountDirection(
  settingsDialog: HTMLDialogElement,
): Promise<FirstAccountDirection> {
  const dialog = document.createElement("dialog");
  dialog.className = "first-account-dialog";
  dialog.setAttribute("aria-labelledby", "first-account-title");
  const title = document.createElement("h2");
  title.id = "first-account-title";
  title.textContent = "选择整个仪表盘的数据";
  const message = document.createElement("p");
  message.textContent =
    "本地和云端都已有数据。请选择保留方向；该选择会统一应用于全部模块。";
  const actions = document.createElement("div");
  actions.className = "first-account-actions";
  const localWins = document.createElement("button");
  localWins.type = "button";
  localWins.className = "primary-button";
  localWins.textContent = "本地覆盖云端";
  const cloudWins = document.createElement("button");
  cloudWins.type = "button";
  cloudWins.className = "danger-button";
  cloudWins.textContent = "云端覆盖本地";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-button";
  cancel.textContent = "取消";
  actions.append(localWins, cloudWins, cancel);
  dialog.append(title, message, actions);
  settingsDialog.after(dialog);

  return new Promise((resolve, reject) => {
    const finish = (direction?: FirstAccountDirection): void => {
      dialog.close();
      dialog.remove();
      if (direction) resolve(direction);
      else reject(new AccountSetupCancelledError());
    };
    localWins.addEventListener("click", () => finish("local-wins"));
    cloudWins.addEventListener("click", () => finish("cloud-wins"));
    cancel.addEventListener("click", () => finish());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    dialog.showModal();
  });
}

function createField(
  text: string,
  type: HTMLInputElement["type"],
  name: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "account-field";
  const title = document.createElement("span");
  title.textContent = text;
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.required = true;
  label.append(title, input);
  return { label, input };
}

type IconRenderer = typeof Config;

function createIcon(renderer: IconRenderer, className: string): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderer({
    size: 22,
    strokeWidth: 3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    theme: "outline",
    fill: "currentColor",
  }).replace(/^<\?xml[^>]*>\s*/u, "");
  const icon = template.content.querySelector("svg");
  if (!icon) throw new Error("IconPark did not return an SVG element.");
  icon.classList.add(className);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

function createIconButton(label: string, renderer: IconRenderer): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.append(createIcon(renderer, "button-icon"));
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

class AccountSetupCancelledError extends Error {}
