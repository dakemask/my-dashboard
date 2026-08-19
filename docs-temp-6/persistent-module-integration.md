# 新增持久化模块接入

## 代码组成

一个持久化模块由业务协议、页面控制器和独立页面入口组成。当前项目使用以下结构：

```text
src/<module-id>/
  definition.ts
  main.ts
  style.css
  domain/
  app/controller.ts
  ui/

modules/<module-id>/index.html
```

`domain` 保存 payload、事件、校验和远端编解码；`controller` 连接业务页面与 Shared 运行时；`definition.ts` 汇总 Shared 所需的业务协议；`main.ts` 只负责启动和挂接运行时。模块目录、`moduleId` 和首页 `routeSlug` 使用同一个 kebab-case 标识。

## 模块定义

JSON 兼容的业务 payload 使用 `defineJsonModule`。定义集中放在 `src/<module-id>/definition.ts`：

```ts
export const moduleDefinition = defineJsonModule<Payload, Event>({
  moduleId: "module-id",
  createEmpty,
  migration: {
    currentVersion: 1,
    migrate,
  },
  validate,
  history: {
    capacity: 100,
    apply,
    invert,
  },
  encode,
  decode,
});
```

定义中的各部分来自模块自身：

- `Payload` 是当前 schema 的完整业务真值，能够被 `structuredClone`，不包含页面选择、草稿或 DOM 对象。
- `createEmpty` 返回通过当前校验的空 payload。
- `validate` 校验并规范化整个 payload，包括跨实体关系。
- `Event` 表示持久化业务变化；`apply` 生成新 payload，`invert` 根据变化前后数据生成精确逆事件。
- `history.capacity` 是页面会话保留的事件数量。
- `encode` 把 payload 转为相对路径到文本内容的 `ReadonlyMap`；`decode` 从这些受管文件还原待校验数据。
- `migration.currentVersion` 对应当前 schema 版本，`migrate` 每次只把数据推进一个版本。

`defineJsonModule` 使用规范 JSON 内容键判断语义变化。只有 payload 不采用 JSON 数据模型时，才使用 `defineModule` 并提供稳定的 `contentKey`。

## 控制器与运行时

控制器持有当前运行时 payload、Shared 快照和模块页面期状态，并公开 `ModuleRuntimeHooks`：

```ts
readonly hooks: ModuleRuntimeHooks<Payload, Event> = {
  settle: (reason) => this.settle(reason),
  project: (payload, reason) => this.project(payload, reason),
  onSnapshotChange: (snapshot) => this.onSnapshotChange(snapshot),
};
```

- `settle` 结束仍停留在控件中的编辑。有效编辑返回一个事件，由 Shared 派发；没有待提交变化时返回 `null`。
- `project` 接收初始化、撤销或重做后的完整 payload，并据此重建页面。
- `onSnapshotChange` 更新本地保存和云端同步状态。

用户产生业务变化时，控制器调用 `runtime.dispatch(event)`，并使用返回的 payload 更新页面。`dispatch` 只更新页面会话；本地保存需要随后显式调用 `runtime.save()`。自动保存时机和保存失败展示由模块控制器管理，运行时已经接受的业务变化不会因随后保存失败而从页面回退。

控制器还负责把 `undo()`、`redo()`、保存重试和页面销毁接到运行时。销毁控制器时一并调用 `runtime.dispose()`，释放轮询、存储连接和编辑租约。

## 启动入口

`src/<module-id>/main.ts` 创建控制器并调用 `startModuleRuntime`：

```ts
const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("Module app root is missing.");

const controller = new ModuleController(appRoot);

try {
  const result = await startModuleRuntime({
    definition: moduleDefinition,
    appRoot,
    hooks: controller.hooks,
    cloudStatusLabel: "正在处理模块云端数据…",
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
```

Shared 在返回 `ready` 前完成 profile 选择、编辑租约、本地记录和初始 payload 的建立。`blocked`、`unsupported` 和 `authentication-required` 不会返回可编辑运行时。

## 同步界面

模块使用 `ModuleSyncUi` 展示本地与云端状态。控制器在构造页面时提供挂载节点和 `guardAction`，运行时 ready 后调用 `attachRuntime`，每次收到 Shared 快照时调用 `renderSnapshot`，销毁时调用 `dispose`。

`guardAction` 只处理模块内部尚未稳定的交互，例如活动草稿、编辑对话框、拖动或本地保存失败。上传、拉取、冲突确认以及本地模式下隐藏云端操作由 `ModuleSyncUi` 处理。

模块 HTML 同时加载 Shared 的持久化操作样式和模块自身样式：

```html
<link rel="stylesheet" href="/src/shared/ui/operationGate.css" />
<link rel="stylesheet" href="/src/<module-id>/style.css" />
```

## 项目注册

模块代码完成后还需要进入项目的页面和持久化模块清单：

1. 在 `modules/<module-id>/index.html` 建立独立页面，沿用模块页 CSP，挂载 `#app` 并加载模块的 `main.ts`；`connect-src` 保留 GitHub API。
2. 在 `vite.config.ts` 的 `build.rollupOptions.input` 中加入该 HTML 页面。
3. 在 `src/home/modules.ts` 导入模块定义，并向 `dashboardModuleCatalog` 添加 `routeSlug`、标题、描述和 `definition: eraseDefinition(moduleDefinition)`。
4. 更新项目文档前读取 `docs-temp-6/documentation-maintenance.md`。
5. 在 `docs-temp-6/AGENTS.md` 中加入新模块概述和文档路由。
6. 在 `docs-temp-6/<module-id>.md` 中编写模块文档，包含“概览”“核心模型”“事件模型”和“代码入口”。

带有 `definition` 的目录项会同时进入 `persistentDashboardDefinitions`，首页首次账户接入、profile 数据建立和清理流程会据此覆盖该模块。只加入页面链接而不加入 definition，不会形成完整的持久化模块接入。
