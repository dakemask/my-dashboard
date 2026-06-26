import { queryRequired } from "../shared/dom";
import { dashboardModules } from "./modules";
import "./style.css";

const moduleList = queryRequired<HTMLDivElement>("#moduleList");

function renderModules(): void {
  moduleList.replaceChildren();

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

renderModules();
