# Shared 模块 SDK 使用指南

## 1. 目标

这是一份给业务模块开发 agent 的操作说明书。开始前先读 [通用模块约束](./general-module-constraints.md)，然后只使用 Shared 根入口提供的 API。

模块 SDK 会自动完成：

- 恢复统一登录；凭据缺失或失效时返回首页登录边界；
- 获取单模块编辑锁并渲染阻止页面；
- 创建历史、本地 IndexedDB、GitHub 仓库和同步协调器；
- 安装 `Ctrl+Z`、`Ctrl+Y`；
- 串行执行命令并运行前台/后台轮询；
- 本地保存时设置 `inert`；
- 云端操作时使用公共 spinner、模糊遮罩和公共 CSS；
- 页面关闭、初始化失败或登录失效时释放全部资源。

模块不需要也不得重复实现这些功能。

## 2. 唯一导入入口

业务模块只从 `src/shared` 根入口导入。相对路径根据模块所在目录调整，但不能深入导入 `shared/auth`、`shared/github` 等内部目录。

```ts
import {
  defineJsonModule,
  startModuleRuntime,
  type ModuleRuntime,
} from "../shared";
```

## 3. 第一步：定义完整 payload

下面是一个最小 JSON 模块。`defineJsonModule` 已经提供规范 JSON content key。

```ts
interface NotesPayload {
  notes: Array<{
    id: string;
    text: string;
  }>;
}

export const notesDefinition = defineJsonModule<NotesPayload>({
  moduleId: "notes",

  createEmpty: () => ({ notes: [] }),

  validate(value: unknown): NotesPayload {
    if (!value || typeof value !== "object") {
      throw new TypeError("Invalid notes payload.");
    }

    const notes = (value as { notes?: unknown }).notes;
    if (!Array.isArray(notes) || !notes.every((note) =>
      note !== null &&
      typeof note === "object" &&
      typeof (note as { id?: unknown }).id === "string" &&
      typeof (note as { text?: unknown }).text === "string"
    )) {
      throw new TypeError("Invalid notes payload.");
    }

    return {
      notes: notes.map((note) => ({
        id: (note as { id: string }).id,
        text: (note as { text: string }).text,
      })),
    };
  },

  encode: (payload) => new Map([
    ["notes.json", `${JSON.stringify(payload, null, 2)}\n`],
  ]),

  decode: (files) =>
    JSON.parse(files.get("notes.json") ?? "null") as NotesPayload,
});
```

要求：

- `createEmpty` 返回完整空模块，不返回部分对象；
- `validate` 校验从 IndexedDB 和云端得到的数据；
- `encode` 和 `decode` 必须无损往返；
- 文件路径相对于模块根目录，不得写 `revision.json` 或其他模块路径。

## 4. 第二步：提供两个核心回调

模块必须实现 `settle` 和 `project`。

```ts
const hooks = {
  settle(reason: "local-save" | "upload" | "undo" | "redo") {
    if (正在编辑文本) {
      // 退出编辑，并返回结算后的完整 payload。
      return buildCompletePayloadFromEditor();
    }

    if (正在拖拽但该拖拽尚未到提交点) {
      cancelLiveDrag();
    }

    return null;
  },

  project(payload: NotesPayload) {
    resetAllLiveInteractionState();
    renderCompleteModule(payload);
  },

  onConflict(conflict: { observedRemoteRevision: string | null }) {
    showConflictNotice(conflict);
  },

  onCommandError() {
    // 只显示本地定义的安全提示，不直接输出原始错误对象。
    showSafeMessage("操作失败，请重试。");
  },
};
```

`settle` 的返回值规则：

- 返回完整 payload：SDK 先把它作为一个历史步骤提交，再继续当前命令；
- 返回 `null`：没有新的业务步骤，SDK 直接继续。

`project` 会在初始化、撤销和重做时调用。初始化时 runtime 尚未返回，因此 `project` 不得依赖 runtime 变量；它只应依赖传入的 payload。

## 5. 第三步：一行启动模块运行时

```ts
async function main(): Promise<void> {
  const appRoot = document.querySelector<HTMLElement>("#app");
  if (!appRoot) throw new Error("Missing #app root.");

  const result = await startModuleRuntime({
    definition: notesDefinition,
    appRoot,
    hooks,
    cloudStatusLabel: "正在同步笔记",
  });

  if (result.status !== "ready") {
    // SDK 已处理：跳转登录页，或渲染重复标签/不支持浏览器页面。
    return;
  }

  runtime = result.runtime;
}

let runtime: ModuleRuntime<NotesPayload> | null = null;
void main();
```

启动结果只有四种：

| `status` | 含义 | 模块要做什么 |
| --- | --- | --- |
| `ready` | 可以编辑 | 保存返回的 `runtime` |
| `authentication-required` | 没有有效登录 | 不处理，SDK 返回首页登录边界 |
| `blocked` | 同模块已在其他标签编辑 | 不处理，SDK 已渲染阻止页面 |
| `unsupported` | 浏览器没有安全 Web Locks | 不处理，SDK 已渲染阻止页面 |

启动异常表示真正的初始化失败。模块入口可以显示一条安全的“初始化失败，请刷新重试”，但不得显示 token、请求头或任意序列化的原始异常。

## 6. 日常编辑和历史

每个业务动作完成时，把完整 payload 提交给 runtime：

```ts
const nextPayload = buildCompletePayload();
runtime?.commit(nextPayload);
```

可读取的状态：

```ts
runtime.current;
runtime.canUndo;
runtime.canRedo;
runtime.dirty;
runtime.getSnapshot();
```

SDK 已自动安装 `Ctrl+Z` 和 `Ctrl+Y`，不要再安装第二套通用撤销快捷键。按钮需要撤销或重做时，可以调用：

```ts
await runtime.undo();
await runtime.redo();
```

不要直接修改 `runtime.current`。它是隔离副本；修改完成后仍需把新的完整 payload 交给 `commit`。

## 7. 保存、上传和拉取

### 7.1 保存按钮

```ts
saveButton.addEventListener("click", () => {
  void runtime?.save().catch(() => {
    showSafeMessage("保存失败，请重试。");
  });
});
```

保存期间 SDK 会让 `appRoot` 不可交互，但不会显示遮罩。

### 7.2 上传按钮

```ts
uploadButton.addEventListener("click", () => {
  void runtime?.upload()
    .then((result) => {
      if (result === "conflict") {
        // onConflict 已负责显示冲突提示，不显示普通网络失败。
        return;
      }
    })
    .catch(() => {
      showSafeMessage("上传失败，请重试。");
    });
});
```

`upload()` 会先结算实时交互；如果当前内容尚未本地保存，会先原子保存。上传、拉取和覆盖期间的 spinner 与遮罩由 SDK 自动显示，模块不得自己切换它们。

### 7.3 主动拉取

```ts
await runtime.pull();
```

如果两端都改变，runtime 会持久化冲突，不会覆盖数据。

upload、pull 或冲突解决返回 `"conflict"` 时，表示冲突已安全持久化；这不是普通网络失败，UI 应交给 `onConflict` 和冲突按钮处理。

## 8. 冲突 UI

模块可以自行决定冲突提示的外观，但只能调用两个方向：

```ts
await runtime.resolveConflict("local-wins");
await runtime.resolveConflict("cloud-wins");
```

不要提供“自动合并”或绕过 runtime 的覆盖按钮。冲突存在时仍可继续本地编辑和保存，但再次上传或主动拉取前必须选择方向。

## 9. 模块特有快捷键

SDK 只提供通用 `Ctrl+Z` 和 `Ctrl+Y`。如果模块需要 `Ctrl+S`，由模块安装并调用同一个 `runtime.save()`：

```ts
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void runtime?.save().catch(() => showSafeMessage("保存失败，请重试。"));
  }
});
```

模块自己的快捷键在页面销毁时也必须移除。

## 10. 非 JSON payload

非 JSON 模块使用 `defineModule`，并提供稳定的 `contentKey`：

```ts
const sortedEntries = (payload: Map<string, number>): Array<[string, number]> =>
  [...payload].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

const definition = defineModule<Map<string, number>>({
  moduleId: "counters",
  createEmpty: () => new Map(),
  validate(value) {
    if (
      !(value instanceof Map) ||
      ![...value].every(([name, count]) =>
        typeof name === "string" && typeof count === "number"
      )
    ) {
      throw new TypeError("Invalid counters.");
    }
    return new Map(value as Map<string, number>);
  },
  contentKey: (payload) => JSON.stringify(sortedEntries(payload)),
  encode: (payload) => new Map([
    ["counters.json", JSON.stringify(sortedEntries(payload))],
  ]),
  decode: (files) => new Map(
    JSON.parse(files.get("counters.json") ?? "[]") as Array<[string, number]>,
  ),
});
```

payload 类型和远端文件格式是两回事：payload 可以是 `Map`，同时编码为 JSON 文本；也可以编码为其他 UTF-8 文本。

## 11. 生命周期

普通页面关闭时 SDK 自动监听 `pagehide` 并释放资源。如果模块在单页应用中被卸载但页面没有关闭，必须显式调用：

```ts
await runtime.dispose();
```

销毁会停止轮询、移除 Shared 快捷键、等待正在进行的操作、关闭 IndexedDB，并释放编辑锁。销毁后的 runtime 不得再次使用；重新进入模块应重新调用 `startModuleRuntime`。

## 12. 模块测试重点

模块自己的测试至少覆盖：

- `validate` 接受合法值、拒绝损坏值；
- content key 对字段顺序稳定，并覆盖所有业务差异；
- `encode → decode → validate` 后 content key 不变；
- 每个复合动作只提交一次完整 payload；
- `settle` 对保存、上传、撤销、重做的模块特有处理；
- `project` 会清除实时交互状态；
- 保存、冲突提示和两个解决按钮正确调用 runtime。

模块不需要重复测试 GitHub 原子 commit、IndexedDB CAS、轮询间隔、Web Locks 或 spinner；这些由 Shared 自己的测试负责。

## 13. 禁止事项速查

业务模块不得：

- 深入导入 `shared/auth`、`shared/github`、`shared/persistence`、`shared/sync` 等内部目录；
- 自己读取 localStorage 凭据；
- 自己创建 IndexedDB、GitHub client、轮询器、编辑锁或云端遮罩；
- 直接修改远端 `revision.json`；
- 用 patch 或 DOM 对象代替完整 payload；
- 同时安装另一套 `Ctrl+Z`/`Ctrl+Y`；
- 在错误文本或日志中输出 token、请求头或原始 GitHub 响应体。

平台维护者需要了解第二个 `ModuleRuntimeEnvironment` 参数时，阅读 [Shared 与平台内部规范](./shared-platform-internals.md)。业务模块不要传这个参数。
