# 新持久化模块接入指南

## 使用范围

本文只在首次创建持久化模块，或已有模块需要重做 SDK 接线时使用。开始前阅读 [持久化模块公共契约](./persistent-module-contract.md)。模块进入日常维护后，只读公共契约和该模块自己的长期文档。

下面以 `notes` 为最小示例。实际目录可以按模块复杂度拆分，但业务模块始终只从 `src/shared` 根入口导入。

```text
modules/notes/index.html
src/notes/main.ts
src/notes/definition.ts
src/notes/domain/types.ts
src/notes/domain/events.ts
src/notes/domain/codec.ts
src/notes/app/controller.ts
src/notes/ui/shell.ts
```

每一步都必须达到自己的完成标准后再继续；测试要求属于接入验收，不表示每次阅读本文都要重新编写同一套测试。

## 第一步：定义 moduleId、完整 payload 和实时状态

### 本步目标

确定模块的一份“完整业务数据”是什么，并把页面实时状态与系统状态排除在外。

### 创建或修改的文件

- `src/notes/domain/types.ts`
- 模块长期文档的“业务模型”草稿（如果该模块需要长期文档）

### 使用或实现的公共接口

- 选择稳定且唯一的 `moduleId`，格式为小写字母/数字和单连字符。
- 设计可被 `structuredClone` 的 `TPayload`。

### 最小代码示例

```ts
export interface Note {
  readonly id: string;
  readonly text: string;
}

export interface NotesPayload {
  readonly notes: readonly Note[];
}

export interface NotesLiveState {
  editingId: string | null;
  draftText: string;
}
```

`NotesPayload` 是完整业务数据。焦点、草稿、DOM 引用、保存时间、冲突和 token 都不是 payload。

### 必须编写的测试

- 合法 payload 可以 `structuredClone`，并保持业务含义。
- 业务字段齐全；实时状态和系统元数据没有混入 payload。
- 模块 ID 合法且与其他模块不重复。

### 完成标准

任意时刻只看一份 payload 就能完整描述模块业务数据；不需要读取 DOM、历史或同步状态来补全它。

## 第二步：定义业务 event 和提交点

### 本步目标

把用户完成的语义动作表示为可克隆 event，并明确什么时刻才进入历史。

### 创建或修改的文件

- `src/notes/domain/types.ts`
- 模块长期文档的“用户界面与操作流程”和“Event 定义”草稿

### 使用或实现的公共接口

- 定义 `TEvent`。
- 每个 event 必须能被 `structuredClone`，且不包含 DOM event、函数或系统元数据。

### 最小代码示例

```ts
export type NotesEvent =
  | { readonly type: "insert-note"; readonly index: number; readonly note: Note }
  | { readonly type: "remove-note"; readonly index: number }
  | { readonly type: "set-note-text"; readonly id: string; readonly text: string };
```

对应提交点：创建完成时提交 `insert-note`；确认删除时提交 `remove-note`；文字 blur/确认且内容有效时提交 `set-note-text`。输入过程本身不连续产生 event。

### 必须编写的测试

- 每种核心用户动作恰好映射到一个 event。
- 一次复合动作不会拆成多次历史提交。
- 取消、无效输入和纯选择变化不产生 event。

### 完成标准

event 表可以回答“用户做了什么、何时算完成”，而不是记录 pointermove、keydown 等机械 DOM 过程。

## 第三步：实现 apply、invert 并选择历史容量

### 本步目标

让每个 event 能纯函数地计算新 payload，并能生成恢复变化前内容的 inverse。

### 创建或修改的文件

- `src/notes/domain/events.ts`
- `src/notes/definition.ts`

### 使用或实现的公共接口

- `ModuleHistoryPolicy.apply(payload, event)`
- `ModuleHistoryPolicy.invert(event, before, after)`
- `HistoryCapacity`：正整数或 `"unlimited"`

### 最小代码示例

```ts
export function applyNotesEvent(
  payload: NotesPayload,
  event: NotesEvent,
): NotesPayload {
  switch (event.type) {
    case "insert-note": {
      const notes = [...payload.notes];
      notes.splice(event.index, 0, { ...event.note });
      return { notes };
    }
    case "remove-note":
      return { notes: payload.notes.filter((_, index) => index !== event.index) };
    case "set-note-text":
      return {
        notes: payload.notes.map((note) =>
          note.id === event.id ? { ...note, text: event.text } : note
        ),
      };
  }
}

export function invertNotesEvent(
  event: NotesEvent,
  before: NotesPayload,
): NotesEvent {
  switch (event.type) {
    case "insert-note":
      return { type: "remove-note", index: event.index };
    case "remove-note":
      return { type: "insert-note", index: event.index, note: before.notes[event.index]! };
    case "set-note-text":
      return {
        type: "set-note-text",
        id: event.id,
        text: before.notes.find((note) => note.id === event.id)!.text,
      };
  }
}
```

### 必须编写的测试

- 每种 event 的 apply 不修改输入。
- `apply(forward)` 后再 `apply(inverse)` 恢复原 content key。
- 非法索引、重复 ID 或缺失目标失败时不产生部分 payload。
- no-op、撤销后新分支和所选容量边界符合公共契约。

### 完成标准

所有业务 event 均可逆；模块已记录具体容量和理由，而不是沿用一个无依据的通用数字。

## 第四步：实现空数据、校验、content key 和远端 codec

### 本步目标

建立 payload 的所有持久化边界，并保证本机与云端往返后业务内容不变。

### 创建或修改的文件

- `src/notes/domain/model.ts`
- `src/notes/domain/codec.ts`
- `src/notes/definition.ts`

### 使用或实现的公共接口

- JSON payload：`defineJsonModule`
- 非 JSON payload：`defineModule`、稳定的 `contentKey`
- `createEmpty`、`validate`、`encode`、`decode`

### 最小代码示例

```ts
import { defineJsonModule } from "../shared";

export const notesDefinition = defineJsonModule<NotesPayload, NotesEvent>({
  moduleId: "notes",
  createEmpty: () => ({ notes: [] }),
  validate: validateNotesPayload,
  history: {
    capacity: 200,
    apply: applyNotesEvent,
    invert: invertNotesEvent,
  },
  encode: (payload) => new Map([
    ["notes.json", `${JSON.stringify(payload, null, 2)}\n`],
  ]),
  decode: (files) => JSON.parse(files.get("notes.json") ?? "null") as NotesPayload,
});
```

`validate` 必须检查完整结构、ID 和不变量，并返回规范化副本。非 JSON payload 改用 `defineModule`，自行提供跨刷新稳定、覆盖全部业务差异的 content key；远端文件仍由 codec 编码为 UTF-8 文本。

### 必须编写的测试

- `createEmpty()` 产生合法完整 payload。
- validate 接受合法值、拒绝缺字段、多余字段和破坏不变量的值。
- `encode → decode → validate` 后 content key 不变。
- 相同业务 payload 的 content key 与受管文件稳定；所有业务差异都会改变 key。
- codec 不写 `revision.json`、绝对路径、父目录逃逸或其他模块目录。

### 完成标准

definition 能独立描述模块的空数据、校验、历史和远端表示；JSON 与非 JSON 的选择是模块明确决定，而不是 SDK 假设。

## 第五步：实现 settle 和 project

### 本步目标

规定公共命令到来时如何结束实时交互，以及完整 payload 如何重新投影到页面。

### 创建或修改的文件

- `src/notes/app/controller.ts`
- 负责草稿、拖动或投影的 UI 文件

### 使用或实现的公共接口

- `ModuleRuntimeHooks.settle(reason)`
- `ModuleRuntimeHooks.project(payload, reason)`
- 可选 `onConflict`、`onSnapshotChange` 留到第八步接入

### 最小代码示例

```ts
const hooks: ModuleRuntimeHooks<NotesPayload, NotesEvent> = {
  settle(reason: SettleReason): NotesEvent | null {
    void reason;
    const edit = finishValidTextDraftOrCancelInvalidDraft();
    cancelUncommittedPointerWork();
    return edit
      ? { type: "set-note-text", id: edit.id, text: edit.text }
      : null;
  },

  project(payload: NotesPayload, reason: ProjectionReason): void {
    cancelAllLiveInteraction();
    renderCompletePayload(payload, reason);
  },
};
```

settle 必须逐一考虑 `local-save`、`upload`、`pull`、`remote-change`、`undo`、`redo`；一次调用返回至多一个 event。project 只接收 `initialize`、`undo`、`redo`。

### 必须编写的测试

- 六种 settle reason 下，所有可能的草稿和 pointer 状态都被提交或取消。
- 无变化返回 null；有效变化返回一个 event。
- project 从 payload 重建页面，并清除不再可靠的实时状态。
- project initialize 不依赖尚未赋值的 runtime。

### 完成标准

任何公共命令都不会在未定义的半编辑状态读取 payload；撤销、重做和初始化后页面只反映传入的完整 payload。

## 第六步：建立页面并启动 runtime

### 本步目标

建立严格 CSP 页面，加载 Shared 公共操作样式，并处理 runtime 的四种启动结果。

### 创建或修改的文件

- `modules/notes/index.html`
- `src/notes/main.ts`
- 模块页面 CSS

### 使用或实现的公共接口

- `startModuleRuntime`
- `StartModuleRuntimeOptions`
- `ModuleRuntimeStartResult`

### 最小代码示例

```html
<link rel="stylesheet" href="/src/shared/ui/operationGate.css" />
<link rel="stylesheet" href="/src/notes/style.css" />
```

```ts
const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("Missing #app root.");

const result = await startModuleRuntime({
  definition: notesDefinition,
  appRoot,
  hooks,
  cloudStatusLabel: "正在同步笔记",
});

if (result.status === "ready") {
  controller.attachRuntime(result.runtime);
}
```

严格 CSP 页面必须用外部 link 加载唯一的 `operationGate.css`。不要从 TypeScript 动态导入或复制它，否则开发服务器可能把 CSS 变成 CSP 拒绝的内联 style。`blocked`、`unsupported` 和 `authentication-required` 已由 SDK 处理，模块不要再建立第二套页面。

### 必须编写的测试

- ready 时只保存一个 runtime，并能使用 initial payload。
- 其余三种结果不会进入业务编辑状态。
- 初始化异常只显示安全文案。
- 页面卸载时模块监听被清理；SPA 卸载会等待 dispose。

### 完成标准

模块页面在严格 CSP 下启动；Shared 的登录、单标签锁和公共阻塞 UI 没有被模块重复实现。

## 第七步：把业务动作连接到 dispatch

### 本步目标

让控制器把已完成用户动作转换成 event，并用 runtime 返回的新 payload 更新页面。

### 创建或修改的文件

- `src/notes/app/controller.ts`
- 产生业务命令的视图组件

### 使用或实现的公共接口

- `runtime.dispatch(event)`
- 只读 `runtime.current`、`canUndo`、`canRedo`、`dirty`

### 最小代码示例

```ts
function commitText(id: string, text: string): void {
  const next = runtime.dispatch({ type: "set-note-text", id, text });
  renderCompletePayload(next);
}
```

视图发出“文字已经提交”之类的命令；控制器构造 event。不得直接修改 `runtime.current`，也不得让 DOM 成为业务数据真源。

### 必须编写的测试

- 每个提交点只调用一次 dispatch，event 内容完整。
- 取消、无效输入和纯实时变化不 dispatch。
- 复合动作只产生一个 event。
- dispatch 抛错时 UI 不假装成功，当前投影仍对应原 payload。

### 完成标准

所有业务写入只有一条路径：视图命令 → 控制器构造 event → runtime.dispatch → 完整 payload 投影。

## 第八步：接入保存、同步、冲突和状态 UI

### 本步目标

把模块自己的按钮和提示连接到 SDK 的持久化命令，而不复制同步实现。

### 创建或修改的文件

- `src/notes/app/controller.ts`
- `src/notes/ui/shell.ts`

### 使用或实现的公共接口

- `save`、`upload`、`pull`、`resolveConflict`
- `getSnapshot`
- `onConflict`、`onSnapshotChange`

### 最小代码示例

```ts
hooks.onSnapshotChange = (snapshot) => shell.renderSyncState(snapshot);
hooks.onConflict = () => shell.showConflictChoices();

saveButton.addEventListener("click", () => runSafely(() => runtime.save()));
uploadButton.addEventListener("click", () => runSafely(() => runtime.upload()));
pullButton.addEventListener("click", () => runSafely(() => runtime.pull()));

localWinsButton.addEventListener("click", () =>
  runSafely(() => runtime.resolveConflict("local-wins"))
);
cloudWinsButton.addEventListener("click", () =>
  runSafely(() => runtime.resolveConflict("cloud-wins"))
);
```

模块决定冲突提示外观和确认流程；只有两个覆盖方向。捕获错误时显示固定安全文案，不输出 token、请求头或原始 GitHub 响应。

### 必须编写的测试

- 各按钮调用正确 runtime 方法，不直接访问存储或 GitHub。
- snapshot 时间、dirty、本地领先、pending 和 conflict 显示互不混淆。
- 用户取消覆盖时不调用 resolveConflict。
- onSnapshotChange 抛错不被当作命令失败。
- 所有 GitHub 边界使用 fake fetch。

### 完成标准

模块只负责用户可见的命令和选择；保存、遮罩、轮询、上传、拉取及冲突持久化全部由 SDK 完成。

## 第九步：连接按钮、菜单和模块快捷键

### 本步目标

按照模块自身交互规则暴露 runtime 功能，并明确清理所有模块监听。

### 创建或修改的文件

- 模块控制器或快捷键文件
- 模块长期文档的“命令与快捷键”部分

### 使用或实现的公共接口

- 按需使用 `undo`、`redo`、`save` 及其他 runtime 命令。
- Shared 不注册、选择或清理模块键位。

### 最小代码示例

```ts
function onKeyDown(event: KeyboardEvent): void {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
  if (event.key.toLowerCase() === "z") {
    event.preventDefault();
    void runtime.undo().catch(showSafeUndoError);
  }
}

document.addEventListener("keydown", onKeyDown);
// 模块卸载时：document.removeEventListener("keydown", onKeyDown)
```

示例键位不是通用要求。是否在输入控件中接管、是否支持 Ctrl/Meta、命令优先级和 IME 行为都由模块文档决定。

### 必须编写的测试

- 按钮、菜单和已声明键位调用正确命令。
- 输入控件、组合输入和修饰键优先级符合模块规则。
- 重复挂载不会重复注册；卸载后监听消失。

### 完成标准

模块的所有命令入口都有明确用户语义和清理责任；不存在 SDK 暗中绑定的快捷键假设。

## 第十步：注册模块、完成长期文档和验收

### 本步目标

让首页与构建系统能够访问模块，并留下足以维护业务逻辑的长期说明。

### 创建或修改的文件

- `src/home/modules.ts`
- `vite.config.ts` 或当前多页面构建配置
- `.agents/<module-id>.md`（模块确实需要长期文档时）
- 模块测试与必要的安全视觉夹具

### 使用或实现的公共接口

- 不新增 SDK 接口。
- 复核业务代码只从 `src/shared` 根入口导入。

### 最小代码示例

```ts
export const dashboardModules = [
  {
    id: "notes",
    title: "笔记",
    description: "记录和整理笔记",
    href: "modules/notes/",
  },
];
```

需要长期文档的模块使用固定结构：

1. 模块目标：用户问题、核心场景、明确不做；
2. 业务模型：实体、关系、身份/顺序/归属和业务不变量；
3. 用户界面与操作流程：页面、核心流程、实时状态、提交点和快捷键；
4. 模块内部架构：组件、状态所有者、数据流、源码入口和依赖边界；
5. 持久化 SDK 定义：moduleId、Payload、Event 表、容量、settle、project、codec 和冲突 UI；
6. 异常与边界情况；
7. 验收标准。

简单模块不被强制创建专用文档；但一旦存在模块文档，就只维护这一份长期真相。文档包含准确 Payload/Event 类型时，源码变化必须在同一任务更新文档。

### 必须编写的测试

- 汇总前九步的领域、event、codec、hooks、控制器和 UI 接线测试。
- 首页入口、模块 HTML 和生产构建入口一致。
- 测试不访问真实 GitHub；严格 CSP 夹具不放宽生产规则。
- 模块测试不重复验证 Shared 的 CAS、Git commit、轮询或锁算法。

### 完成标准

首页可进入模块，构建包含正确入口，长期文档首先说明模块业务而非复述 SDK；后续维护不再依赖本文。
