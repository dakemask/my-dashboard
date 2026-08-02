import { Config } from "@icon-park/svg";

import { createIconOnlyButton } from "../../shared";
import type { DashboardProfileState } from "../../shared/profiles";
import type { DashboardModule } from "../modules";

export interface HomePageOptions {
  readonly document: Document;
  readonly profile: DashboardProfileState;
  readonly modules: readonly DashboardModule[];
  readonly onOpenAccountSettings: (trigger: HTMLButtonElement) => void;
}

/** Builds the home page without owning account or persistence workflows. */
export function createHomePage(options: HomePageOptions): HTMLElement {
  const shell = options.document.createElement("main");
  shell.className = "shell";

  const header = options.document.createElement("header");
  header.className = "home-header";
  const heading = options.document.createElement("div");
  heading.className = "home-heading";

  const eyebrow = options.document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "My Dashboard";

  const title = options.document.createElement("h1");
  title.textContent = "功能入口";

  const subtitle = options.document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "选择要打开的模块。";
  heading.append(eyebrow, title, subtitle);

  const settingsButton = createIconOnlyButton(
    options.document,
    Config,
    "账户设置",
    {
      classNames: "settings-button",
      iconClassNames: "settings-button-icon",
    },
  );
  settingsButton.addEventListener("click", () => {
    options.onOpenAccountSettings(settingsButton);
  });
  header.append(heading, settingsButton);

  const mode = options.document.createElement("p");
  mode.className = "home-mode";
  if (options.profile.mode === "local") {
    mode.textContent = "本地模式 · 数据仅保存在此浏览器";
  } else {
    const active = options.profile.accounts.find(
      (account) => account.id === options.profile.activeAccountId,
    );
    mode.textContent = active ? `当前账户 · ${active.username}` : "账户模式";
  }

  const section = options.document.createElement("section");
  section.className = "module-section";
  section.setAttribute("aria-label", "功能模块");

  const moduleList = options.document.createElement("div");
  moduleList.className = "module-list";
  section.append(moduleList);
  shell.append(header, mode, section);

  if (options.modules.length === 0) {
    const empty = options.document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无可用模块。";
    moduleList.append(empty);
    return shell;
  }

  moduleList.append(...options.modules.map((module) =>
    createModuleLink(options.document, module)),
  );
  return shell;
}

function createModuleLink(
  document: Document,
  module: DashboardModule,
): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "module-link";
  link.href = module.href;

  const text = document.createElement("span");
  const title = document.createElement("span");
  title.className = "module-title";
  title.textContent = module.title;

  const description = document.createElement("span");
  description.className = "module-description";
  description.textContent = module.description;

  const action = document.createElement("span");
  action.className = "module-action";
  action.textContent = "进入";

  text.append(title, description);
  link.append(text, action);
  return link;
}
