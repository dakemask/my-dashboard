import { startModuleRuntime } from "../shared";
import { TodosController } from "./app/controller";
import { todosDefinition } from "./definition";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Todos app root is missing.");

const controller = new TodosController(appRoot);

try {
  const result = await startModuleRuntime({
    definition: todosDefinition,
    appRoot,
    hooks: controller.hooks,
    cloudStatusLabel: "正在处理待办云端数据…",
  });
  if (result.status === "ready") controller.attachRuntime(result.runtime, result.initialPayload);
  else await controller.dispose();
} catch {
  await controller.dispose().catch(() => undefined);
  const message = document.createElement("main");
  message.className = "todos-startup-error";
  const title = document.createElement("h1");
  title.textContent = "待办未能启动";
  const detail = document.createElement("p");
  detail.textContent = "本机内容没有被修改。请刷新页面后重试。";
  const link = document.createElement("a");
  link.href = import.meta.env.BASE_URL;
  link.textContent = "返回首页";
  message.append(title, detail, link);
  appRoot.replaceChildren(message);
}

