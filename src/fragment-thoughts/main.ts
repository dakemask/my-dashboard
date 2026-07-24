import { startModuleRuntime } from "../shared";
import { FragmentThoughtsController } from "./app/controller";
import { fragmentThoughtsDefinition } from "./definition";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Fragment Thoughts app root is missing.");

const controller = new FragmentThoughtsController(appRoot);

try {
  const result = await startModuleRuntime({
    definition: fragmentThoughtsDefinition,
    appRoot,
    hooks: controller.hooks,
    cloudStatusLabel: "正在处理碎片想法云端数据…",
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
  message.className = "ft-startup-error";

  const title = document.createElement("h1");
  title.textContent = "碎片想法未能启动";

  const detail = document.createElement("p");
  detail.textContent = "本机内容没有被修改。请刷新页面后重试。";

  const link = document.createElement("a");
  link.href = import.meta.env.BASE_URL;
  link.textContent = "返回首页";

  message.append(title, detail, link);
  root.replaceChildren(message);
}
