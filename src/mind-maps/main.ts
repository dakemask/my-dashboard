import { startModuleRuntime } from "../shared";
import { MindMapController } from "./app/controller";
import { mindMapDefinition } from "./definition";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Mind Map app root is missing.");

const controller = new MindMapController(appRoot);

try {
  const result = await startModuleRuntime({
    definition: mindMapDefinition,
    appRoot,
    hooks: controller.hooks,
    cloudStatusLabel: "正在处理思维导图云端数据…",
  });
  if (result.status === "ready") {
    controller.attachRuntime(result.runtime, result.initialPayload);
  } else {
    await controller.dispose();
  }
} catch {
  await controller.dispose().catch(() => undefined);
  renderStartupFailure(appRoot);
}

function renderStartupFailure(root: HTMLElement): void {
  const message = document.createElement("main");
  message.className = "mind-maps-startup-error";
  const title = document.createElement("h1");
  title.textContent = "思维导图未能启动";
  const detail = document.createElement("p");
  detail.textContent = "本机内容没有被修改。请刷新页面后重试。";
  const link = document.createElement("a");
  link.href = import.meta.env.BASE_URL;
  link.textContent = "返回首页";
  message.append(title, detail, link);
  root.replaceChildren(message);
}
