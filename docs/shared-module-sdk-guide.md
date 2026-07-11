# Shared 模块 SDK 使用指南

## 1. 目标

这是一份给业务模块开发 agent 的操作说明书。开始前先读 [通用模块约束](./general-module-constraints.md)，然后只使用 Shared 根入口提供的 API。

模块 SDK 会自动完成：

- 恢复统一登录；凭据缺失或失效时返回首页登录边界；
- 获取单模块编辑锁并渲染阻止页面；
- 创建当前 payload、event 历史、本地 IndexedDB、GitHub 仓库和同步协调器；
- 串行执行持久化命令并运行前台/后台轮询；
- 本地保存时设置 `inert`；
- 云端操作时使用公共 spinner、模糊遮罩和公共 CSS；
- 页面关闭、初始化失败或登录失效时释放 Shared 资源。

SDK **不会注册任何键盘快捷键**。模块需要哪些按钮、菜单或键位，由模块自己绑定到 runtime 提供的方法。

## 2. 唯一导入入口

业务模块只从 `src/shared` 根入口导入。相对路径根据模块所在目录调整，但不能深入导入 `shared/auth`、`shared/github` 等内部目录。

```ts
import {
  defineJsonModule,
  startModuleRuntime,
  type ModuleRuntime,
  type SettleReason,
} from "../shared";
```

## 3. 第一步：定义 payload、event 和历史策略

下面是一个最小 JSON 模块。payload 是当前全部笔记；event 是一个可撤销的业务动作。

```ts
interface Note {
  id: string;
  text: string;
}

interface NotesPayload {
  notes: Note[];
}

type NotesEvent =
  | { type: "insert-note"; index: number; note: Note }
  | { type: "remove-note"; index: number }
  | { type: "set-note-text"; id: string; text: string };

function applyNotesEvent(payload: NotesPayload, event: NotesEvent): NotesPayload {
  const notes = payload.notes.map((note) => ({ ...note }));

  switch (event.type) {
    case "insert-note":
      if (event.index < 0 || event.index > notes.length) throw new RangeError("Invalid note index.");
      notes.splice(event.index, 0, { ...event.note });
      return { notes };

    case "remove-note":
      if (event.index < 0 || event.index >= notes.length) throw new RangeError("Invalid note index.");
      notes.splice(event.index, 1);
      return { notes };

    case "set-note-text":
      if (!notes.some((note) => note.id === event.id)) throw new Error("Unknown note.");
      return {
        notes: notes.map((note) => note.id === event.id
          ? { ...note, text: event.text }
          : note),
      };
  }
}

function invertNotesEvent(
  event: NotesEvent,
  before: NotesPayload,
  _after: NotesPayload,
): NotesEvent {
  switch (event.type) {
    case "insert-note":
      return { type: "remove-note", index: event.index };

    case "remove-note": {
      const removed = before.notes[event.index];
      if (!removed) throw new RangeError("Invalid note index.");
      return { type: "insert-note", index: event.index, note: { ...removed } };
    }

    case "set-note-text": {
      const oldNote = before.notes.find((note) => note.id === event.id);
      if (!oldNote) throw new Error("Unknown note.");
      return { type: "set-note-text", id: event.id, text: oldNote.text };
    }
  }
}

export const notesDefinition = defineJsonModule<NotesPayload, NotesEvent>({
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
    ) || new Set(notes.map((note) => (note as { id: string }).id)).size !== notes.length) {
      throw new TypeError("Invalid notes payload.");
    }

    return {
      notes: notes.map((note) => ({
        id: (note as { id: string }).id,
        text: (note as { text: string }).text,
      })),
    };
  },

  history: {
    capacity: 200,
    apply: applyNotesEvent,
    invert: invertNotesEvent,
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
- `history.capacity` 必须显式设为正整数或 `"unlimited"`，按 event 数而不是 payload 数计；
- `history.apply` 和 `history.invert` 必须确定、无副作用，不修改传入参数；
- event 和 payload 都必须能被 `structuredClone`；
- `encode` 和 `decode` 必须让完整 payload 无损往返；
- 文件路径相对于模块根目录，不得写 `revision.json` 或其他模块路径。

`defineJsonModule` 只替模块提供规范 JSON content key，不替模块设计 event。一个正向 event 必须能通过 `invert` 得到反向 event；例如删除 event 的 inverse 通常需要从 `before` 中取得被删除内容。

## 4. 第二步：提供 settle 和 project

模块必须实现 `settle` 和 `project`。

```ts
const hooks = {
  settle(reason: SettleReason): NotesEvent | null {
    if (正在编辑文本) {
      const edit = finishTextEditing();
      return {
        type: "set-note-text",
        id: edit.noteId,
        text: edit.text,
      };
    }

    if (正在拖拽但该拖拽尚未到提交点) {
      cancelLiveDrag();
    }

    // reason 可用于区分模块对不同命令的结算规则。
    void reason;
    return null;
  },

  project(payload: NotesPayload) {
    resetAllLiveInteractionState();
    renderCompleteModule(payload);
  },

  onConflict(conflict: { observedRemoteRevision: string | null }) {
    showConflictNotice(conflict);
  },
};
```

`settle` 可能收到六种 reason：

| reason | 何时发生 |
| --- | --- |
| `local-save` | 本地保存读取当前 payload 前 |
| `upload` | 上传或本地覆盖云端前 |
| `pull` | 主动拉取发现云端确有变化后 |
| `remote-change` | 轮询发现云端 revision 变化后 |
| `undo` | 撤销前 |
| `redo` | 重做前 |

返回规则：

- 返回一个 event：SDK 先调用与 `runtime.dispatch(event)` 相同的流程，再继续原命令；
- 返回 `null`：没有新的业务变化，SDK 直接继续。

`settle` 不返回完整 payload。保存和同步最终仍读取 runtime 通过 event 计算得到的当前完整 payload。

`project` 会在初始化、撤销和重做时调用。初始化时 runtime 尚未返回，因此 `project` 不得依赖 runtime 变量；它只应依赖传入的 payload。

## 5. 第三步：启动模块运行时

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

let runtime: ModuleRuntime<NotesPayload, NotesEvent> | null = null;
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

## 6. 日常编辑和 event 历史

一个业务动作到达提交点时 dispatch 一个 event：

```ts
runtime?.dispatch({
  type: "set-note-text",
  id: noteId,
  text: nextText,
});
```

可读取的状态：

```ts
runtime.current;
runtime.canUndo;
runtime.canRedo;
runtime.dirty;
runtime.getSnapshot();
```

`runtime.current` 是当前完整 payload 的隔离副本。不得直接修改它来更新模块；业务更新必须通过 `dispatch(event)`。

SDK 会对 payload、forward event、inverse event 和回调边界使用 `structuredClone`。dispatch 的原子规则是：只有 apply、结果校验、content key、invert 和所需 clone 全部成功后，current 和 event 队列才一起推进；任一步抛错都保持原状。

如果 event 计算出的 content key 没有变化，它是 no-op，不进入历史，也不会删除已有 redo。撤销后 dispatch 真实变化才会删除旧 redo 分支。

模块自己选择历史容量：

- `capacity: 200` 表示最多保留 200 个 forward/inverse event 对；
- `capacity: "unlimited"` 表示当前页面会话内不设 event 数量上限；
- 刷新始终清空 event 队列，只保留已存入 IndexedDB 的完整 payload。

## 7. 撤销、重做和保存入口

SDK 只提供功能方法，不注册键盘：

```ts
await runtime.undo();
await runtime.redo();
await runtime.save();
```

模块可以把按钮、菜单或自己选择的键位绑定到这些方法。下面只是一个同时选择 `Ctrl+Z`、`Ctrl+Y`、`Ctrl+S` 的模块示例，不是所有模块的通用键位要求：

```ts
function runSafely(action: () => Promise<unknown>, message: string): void {
  void action().catch(() => showSafeMessage(message));
}

function onKeyDown(event: KeyboardEvent): void {
  if (!runtime || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

  switch (event.key.toLowerCase()) {
    case "z":
      event.preventDefault();
      runSafely(() => runtime!.undo(), "撤销失败，请重试。");
      break;
    case "y":
      event.preventDefault();
      runSafely(() => runtime!.redo(), "重做失败，请重试。");
      break;
    case "s":
      event.preventDefault();
      runSafely(() => runtime!.save(), "保存失败，请重试。");
      break;
  }
}

document.addEventListener("keydown", onKeyDown);
```

模块卸载时必须移除自己注册的监听。Shared 不知道模块选了哪些键位，也不会替模块移除这些监听。

## 8. 保存、上传和拉取

### 8.1 保存按钮

```ts
saveButton.addEventListener("click", () => {
  if (!runtime) return;
  void runtime.save().catch(() => {
    showSafeMessage("保存失败，请重试。");
  });
});
```

保存期间 SDK 会让 `appRoot` 不可交互，但不会显示遮罩。保存把当前完整 payload 写入 IndexedDB；event 队列仍只留在页面内，并且不会因保存而清空。

### 8.2 上传按钮

```ts
uploadButton.addEventListener("click", () => {
  if (!runtime) return;
  void runtime.upload()
    .then((result) => {
      if (result === "conflict") {
        // onConflict 已负责显示冲突提示。
      }
    })
    .catch(() => {
      showSafeMessage("上传失败，请重试。");
    });
});
```

`upload()` 会先结算实时交互；如果当前 payload 尚未本地保存，会先原子保存。上传、拉取和覆盖期间的 spinner 与遮罩由 SDK 自动显示，模块不得自己切换它们。

### 8.3 主动拉取

```ts
await runtime.pull();
```

如果两端都改变，runtime 会持久化冲突，不会覆盖数据。upload、pull 或冲突解决返回 `"conflict"` 时，表示冲突已安全持久化；这不是普通网络失败，UI 应交给 `onConflict` 和冲突按钮处理。

## 9. 冲突 UI

模块可以自行决定冲突提示的外观，但只能调用两个方向：

```ts
await runtime.resolveConflict("local-wins");
await runtime.resolveConflict("cloud-wins");
```

不要提供“自动合并”或绕过 runtime 的覆盖按钮。冲突存在时仍可继续 dispatch event 和本地保存，但再次上传或主动拉取前必须选择方向。

远端变化与本地 event 形成冲突时，SDK 会在一个原子本地事务中保存当前完整 payload、content hash 和 conflict，再更新本地保存基线。因此刷新不会丢失本地一侧；此时 `runtime.dirty === false` 只说明内容已落到本机，`getSnapshot().localChangedSinceSync` 仍可为 true。

## 10. 非 JSON payload

非 JSON 模块使用 `defineModule`，并同样提供 event 历史策略：

```ts
type CounterEvent = {
  type: "set-count";
  name: string;
  value: number | null;
};

const sortedEntries = (payload: Map<string, number>): Array<[string, number]> =>
  [...payload].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

const definition = defineModule<Map<string, number>, CounterEvent>({
  moduleId: "counters",
  createEmpty: () => new Map(),
  validate(value) {
    if (
      !(value instanceof Map) ||
      ![...value].every(([name, count]) =>
        typeof name === "string" && typeof count === "number" && Number.isFinite(count)
      )
    ) {
      throw new TypeError("Invalid counters.");
    }
    return new Map(value as Map<string, number>);
  },
  contentKey: (payload) => JSON.stringify(sortedEntries(payload)),
  history: {
    capacity: "unlimited",
    apply(payload, event) {
      const next = new Map(payload);
      if (event.value === null) next.delete(event.name);
      else next.set(event.name, event.value);
      return next;
    },
    invert(event, before) {
      return {
        type: "set-count",
        name: event.name,
        value: before.get(event.name) ?? null,
      };
    },
  },
  encode: (payload) => new Map([
    ["counters.json", JSON.stringify(sortedEntries(payload))],
  ]),
  decode: (files) => new Map(
    JSON.parse(files.get("counters.json") ?? "[]") as Array<[string, number]>,
  ),
});
```

payload 类型、event 类型和远端文件格式是三个不同选择：payload 可以是 `Map`，event 是小型业务动作，而完整 payload 仍可编码为 JSON 或其他 UTF-8 文本。

## 11. 生命周期

普通页面关闭时 SDK 自动监听 `pagehide` 并释放 Shared 资源。如果模块在单页应用中被卸载但页面没有关闭，必须先移除模块自己的事件监听，再显式调用：

```ts
document.removeEventListener("keydown", onKeyDown);
await runtime.dispose();
```

销毁会停止轮询、等待正在进行的操作、关闭 IndexedDB，并释放编辑锁。销毁后的 runtime 不得再次使用；重新进入模块应重新调用 `startModuleRuntime`。

## 12. 模块测试重点

模块自己的测试至少覆盖：

- `validate` 接受合法值、拒绝损坏值；
- content key 对字段顺序稳定，并覆盖所有业务差异；
- `encode → decode → validate` 后 content key 不变；
- 每种 event 的 `apply` 不修改输入，`apply + invert + apply` 恢复原 content key；
- 复合动作只 dispatch 一次，no-op 不入队且保留 redo；
- 撤销后 dispatch 新 event 会删除旧 redo 分支；
- 所选正整数容量的边界，或 `"unlimited"` 行为；
- apply、invert、校验或 clone 失败时 current、队列位置和 dirty 均不推进；
- 刷新只从完整本地 payload 开始，不恢复 event 队列；
- `settle` 对模块在六种 reason 下可能存在的交互作出正确处理；
- `project` 会清除实时交互状态；
- 模块按钮、菜单或快捷键正确调用 runtime，并在卸载时清理；
- 保存、冲突提示和两个解决按钮正确调用 runtime。

模块不需要重复测试 GitHub 原子 commit、IndexedDB CAS、轮询间隔、Web Locks 或 spinner；这些由 Shared 自己的测试负责。

## 13. 禁止事项速查

业务模块不得：

- 深入导入 `shared/auth`、`shared/github`、`shared/persistence`、`shared/sync` 等内部目录；
- 自己读取 localStorage 凭据；
- 自己创建 IndexedDB、GitHub client、轮询器、编辑锁或云端遮罩；
- 直接修改远端 `revision.json`；
- 直接修改 `runtime.current`，或绕过 `runtime.dispatch(event)` 推进业务数据；
- 把 event 历史写入 IndexedDB、业务 payload 或远端文件；
- 假定 SDK 已经安装或会清理任何业务快捷键；
- 在 `apply`、`invert`、`validate` 或 codec 中修改参数、操作 DOM 或产生其他副作用；
- 在错误文本或日志中输出 token、请求头或原始 GitHub 响应体。

平台维护者需要了解第二个 `ModuleRuntimeEnvironment` 参数时，阅读 [Shared 与平台内部规范](./shared-platform-internals.md)。业务模块不要传这个参数。
