import { startModuleRuntime } from "../shared";
import { FragmentThoughtsController } from "./app/controller";
import { fragmentThoughtsDefinition } from "./definition";
import { renderSafeStartupFailure } from "./ui/shell";

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
  renderSafeStartupFailure(appRoot);
}
