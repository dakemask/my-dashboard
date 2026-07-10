import { queryRequired } from "../shared/dom";
import { createAuthService, mountLoginGate } from "../shared/auth";
import { dashboardModules } from "./modules";

const app = queryRequired<HTMLDivElement>("#app");
const authService = createAuthService();

mountLoginGate(app, {
  authService,
  onAuthenticated: () => renderHome(),
});

function renderHome(): void {
  const shell = document.createElement("main");
  shell.className = "shell";

  const header = document.createElement("header");
  header.className = "home-header";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "My Dashboard";

  const title = document.createElement("h1");
  title.textContent = "功能入口";

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "选择要打开的模块。";

  header.append(eyebrow, title, subtitle);

  const section = document.createElement("section");
  section.className = "module-section";
  section.setAttribute("aria-label", "功能模块");

  const moduleList = document.createElement("div");
  moduleList.className = "module-list";
  section.append(moduleList);
  shell.append(header, section);
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
  });

  moduleList.append(...links);
}
