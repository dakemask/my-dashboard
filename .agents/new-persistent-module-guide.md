# 新持久化模块接入指南

本文只在首次创建持久化模块，或已有模块需要重做 SDK 接线时使用。开始前阅读 [持久化模块公共契约](./persistent-module-contract.md)；模块完成后，日常维护只读公共契约和该模块自己的长期文档。

下面用 `notes` 表示一个示例模块。目录可以随模块复杂度调整，但业务代码始终只从 `src/shared` 根入口导入。

```text
modules/notes/index.html
src/notes/main.ts
src/notes/definition.ts
src/notes/domain/types.ts
src/notes/domain/model.ts
src/notes/domain/events.ts
src/notes/domain/codec.ts
src/notes/app/controller.ts
src/notes/ui/shell.ts
```

## 第一步：定义业务数据和历史

先写清四件事：

1. 稳定且唯一的 `moduleId`；
2. 能完整表示模块业务内容的 payload；
3. 不进入 payload 的实时状态；
4. 已经完成、能够撤销的业务 event。

```ts
export interface Note {
  readonly id: string;
  readonly text: string;
}

export interface NotesPayload {
  readonly notes: readonly Note[];
}

export interface NotesLiveState {
  readonly editingId: string | null;
  readonly draftText: string;
}

export type NotesEvent =
  | { readonly type: "insert-note"; readonly index: number; readonly note: Note }
  | { readonly type: "set-note-text"; readonly id: string; readonly text: string }
  | { readonly type: "remove-note"; readonly index: number };
```

为每个 event 明确用户动作和提交点。例如，输入过程留在 `NotesLiveState`，blur 或确认时才产生 `set-note-text`。

随后实现纯函数：

```ts
export function applyNotesEvent(
  payload: NotesPayload,
  event: NotesEvent,
): NotesPayload {
  if (event.type === "set-note-text") {
    if (!payload.notes.some((note) => note.id === event.id)) {
      throw new Error("Unknown note id.");
    }
    return {
      notes: payload.notes.map((note) =>
        note.id === event.id ? { ...note, text: event.text } : note
      ),
    };
  }
  const notes = [...payload.notes];
  if (event.type === "insert-note") {
    if (
      event.index < 0 || event.index > notes.length
      || notes.some((note) => note.id === event.note.id)
    ) {
      throw new Error("Invalid note insertion.");
    }
    notes.splice(event.index, 0, event.note);
  } else {
    if (event.index < 0 || event.index >= notes.length) {
      throw new Error("Invalid note removal.");
    }
    notes.splice(event.index, 1);
  }
  return { notes };
}

export function invertNotesEvent(
  event: NotesEvent,
  before: NotesPayload,
  _after: NotesPayload,
): NotesEvent {
  if (event.type === "insert-note") {
    return { type: "remove-note", index: event.index };
  }
  if (event.type === "remove-note") {
    const note = before.notes[event.index];
    if (!note) throw new Error("Cannot restore the removed note.");
    return { type: "insert-note", index: event.index, note };
  }
  const note = before.notes.find((item) => item.id === event.id);
  if (!note) throw new Error("Cannot restore the note text.");
  return { type: "set-note-text", id: event.id, text: note.text };
}
```

最后根据 event 典型大小和实际撤销需求，选择正整数或 `"unlimited"` 的历史容量。不要因为其他模块使用 100 就直接照搬。

这一阶段至少确认：每个业务动作只有一个明确提交点，`apply`/`invert` 可逆，删除等复合动作能由一个 event 完整恢复。

## 第二步：定义持久化边界

实现空数据、校验、内容标识和远端编码：

- `createEmpty()` 返回一份合法的新 payload；
- `validate(value)` 校验未知输入并返回合法 payload；
- `encode(payload)` 返回相对于 `data/<moduleId>/` 的 UTF-8 文本文件；
- `decode(files)` 从这些文件恢复完整 payload。

JSON 兼容 payload 通常这样定义：

```ts
import { defineJsonModule } from "../shared";

export const notesDefinition = defineJsonModule<NotesPayload, NotesEvent>({
  moduleId: "notes",
  createEmpty: () => ({ notes: [] }),
  validate: validateNotesPayload,
  history: {
    capacity: 100, // 这里只是示例值；实际值必须按模块决定。
    apply: applyNotesEvent,
    invert: invertNotesEvent,
  },
  encode: (payload) => new Map([
    ["notes.json", `${JSON.stringify(payload, null, 2)}\n`],
  ]),
  decode: (files) => validateNotesPayload(
    JSON.parse(files.get("notes.json") ?? ""),
  ),
});
```

非 JSON payload 改用 `defineModule`，并提供跨刷新稳定、覆盖全部业务语义的 `contentKey(payload)`；远端编码仍然是 UTF-8 文本，不要求与本地 payload 使用相同数据类型。

codec 只管理模块业务文件：

- 路径相对于模块根目录，不能越界；
- 不生成或读取 Shared 管理的 `revision.json`；
- 相同业务内容必须稳定编码为相同文件；
- `decode(encode(payload))` 必须恢复等价 payload；
- 删除、重命名和空目录等情况必须在文件映射中有明确结果。

## 第三步：实现实时交互边界

在创建 runtime 之前准备完整 hooks。`settle` 处理公共命令到来时仍未结束的页面操作，`project` 处理完整 payload 到来后的页面重建。

```ts
import type { ModuleRuntimeHooks } from "../shared";

export const hooks: ModuleRuntimeHooks<NotesPayload, NotesEvent> = {
  settle(reason) {
    // 提交有效草稿，取消拖拽等未完成交互；返回一个 event 或 null。
    return settleNotesInteraction(reason);
  },
  project(payload, reason) {
    // 依据完整 payload 重建 UI，并清理失效实时状态。
    projectNotes(payload, reason);
  },
  onConflict(conflict) {
    showConflictState(conflict);
  },
  onSnapshotChange(snapshot) {
    renderSaveAndSyncState(snapshot);
  },
};
```

逐一决定六种 settle reason 的模块行为：

```text
local-save / upload / pull / remote-change / undo / redo
```

也要决定三种 projection reason：

```text
initialize / undo / redo
```

常见做法是：有效文字草稿变成 event，无效草稿取消；正在进行的 pointer 操作取消；选择、焦点和临时预览在 project 后按模块规则重建。一个 settle 最多返回一个 event，必要时使用模块自己的复合 event。

## 第四步：建立页面并启动 runtime

模块 HTML 保持严格 CSP，并外链 Shared 的公共操作样式；不要在模块里复制 spinner 或遮罩：

```html
<link rel="stylesheet" href="/src/shared/ui/operationGate.css">
```

模块入口先创建能够提供完整 hooks 的 controller，再启动 runtime：

```ts
import { startModuleRuntime } from "../shared";
import { NotesController } from "./app/controller";
import { notesDefinition } from "./definition";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("Notes app root is missing.");

const controller = new NotesController(appRoot);

try {
  const result = await startModuleRuntime({
    definition: notesDefinition,
    appRoot,
    hooks: controller.hooks,
    cloudStatusLabel: "正在处理笔记云端数据…",
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
```

`blocked`、`unsupported` 和 `authentication-required` 已由公共边界处理，模块不建立第二套登录、锁或阻止页。初始化的 `project` 发生在 `startModuleRuntime` 返回之前，因此不能依赖尚未 attach 的 runtime。

普通独立页面由 SDK 监听 `pagehide`。如果宿主会在页面不关闭时卸载模块，模块还要移除自己的监听并等待 `runtime.dispose()`。

## 第五步：连接用户命令和状态 UI

controller 是业务 UI 与 runtime 之间的边界：

```text
用户完成业务动作 → 构造模块 event → runtime.dispatch(event)
撤销/重做       → runtime.undo() / runtime.redo()
本地保存        → runtime.save()
上传/拉取       → runtime.upload() / runtime.pull()
冲突选择        → runtime.resolveConflict("local-wins" | "cloud-wins")
```

不要先修改一份私有 payload 再通知 runtime。`dispatch` 返回新的完整 payload，controller 应以它作为后续投影依据。

按钮、菜单和快捷键由模块绑定；Shared 不自动绑定。模块应处理忙碌状态，防止把 `ModuleRuntimeBusyError` 当作数据错误，并在卸载时清理所有监听。

保存和同步区域从 `getSnapshot()` 或 `onSnapshotChange` 读取状态，至少区分：

- 页面尚未本地保存；
- 已本地保存但尚未上传；
- 同步一致；
- 上传结果待确认；
- 冲突及两个覆盖方向。

模块只决定这些状态怎样展示、何时请求用户确认。保存基线、冲突持久化、轮询、公共阻塞和遮罩全部交给 SDK。

## 第六步：注册模块并完成验收

完成页面后：

1. 在首页模块注册表添加入口；
2. 在 Vite 多页面构建输入中添加模块 HTML；
3. 确认生产产物不包含测试夹具；
4. 如果模块确实需要长期维护文档，在 `.agents/` 建立一份模块文档。

模块文档不必套固定章数，但应按下面的顺序回答实际问题：

1. 模块做什么，明确不做什么；
2. 业务数据、规则和不变量是什么；
3. 用户如何操作，动作何时完成；
4. 代码放在哪里，状态由谁持有；
5. 如果使用 SDK，本模块具体选择的 moduleId、payload、event、容量、settle、project 和远端 codec 是什么。

简单模块不因形式要求强制建立文档。模块文档只记录本模块的决定，不重复五层模型、IndexedDB、GitHub、编辑锁或同步算法。

最终验收集中检查：

- payload 能独立恢复业务内容，校验和 codec 往返正确；
- 每种 event 的 apply/invert 可逆，容量与分支行为符合模块决定；
- settle/project 覆盖该模块所有实时交互；
- 业务 UI 只通过 runtime 编辑、保存和同步；
- 按钮、快捷键、冲突确认、状态显示和监听清理符合模块规则；
- 严格 CSP 下公共操作样式能够加载；
- 测试使用 fake GitHub 边界，不访问真实私人仓库。

Shared 自身的 IndexedDB 原子性、Git commit、轮询、编辑锁和公共遮罩算法由 Shared 测试负责，业务模块不重复测试。
