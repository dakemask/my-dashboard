# 事件、历史、本地保存与同步

## 持久化边界

`todosDefinition` 把整个 `TodosPayload` 定义为 schema version 1 的 JSON 模块，受管文件必须且只能是 `todos.json`。当前没有低于版本 1 的迁移实现，历史容量为 200 个事件。

本地模式首次启动时，Shared Runtime 在 IndexedDB 中初始化空载荷；账号模式在相同本地状态基础上接入远端模块仓库和修订轮询。页面通过单编辑器租约避免同一 profile 的同一模块被多个页面同时编辑。

## 事件模型

`createTodosEvent(before, after)` 分别比较 `instances` 和 `rules`：每个变化实体记录 ID、完整 `before/after` 值及前后数组索引，因此同一个 `change-entities` 事件可原子表达新增、删除、修改和重排。

应用事件前会检查旧值与旧索引仍然匹配，构造完整目标数组后再校验整个 `TodosPayload`；反转事件会交换前后值/索引并逆序变更列表。这个模型使一次编辑器保存（例如“保存实例并覆盖模板”）可以同时修改实例与规则，又仍然只占一个历史步骤。

## 一次普通命令的状态流

```text
候选 TodosPayload
  -> validateTodosPayload
  -> createTodosEvent(current, candidate)
  -> Runtime.dispatch(event)
  -> Runtime/History 接受并返回新 payload
  -> 控制器立即替换 #payload 并投影 UI
  -> Runtime.save() 尝试保存本地状态
```

关键语义是“命令接受”和“本地保存”分离：

| 阶段结果 | 页面/状态处理 |
| --- | --- |
| dispatch/undo/redo 本身失败 | 不投影、不尝试保存，显示命令失败消息。 |
| 命令成功且保存成功 | 保留新状态，并清除之前的本地保存失败标记。 |
| 命令成功但保存失败 | 新状态和历史仍然保留，显示持续的“自动保存失败”区域并允许重试。 |
| 手动重试失败 | 失败标记继续存在。 |
| 手动重试成功 | 清除失败标记。 |

不要在保存失败时把 `#payload` 恢复为旧值，这会让 UI 与 Runtime 历史分叉。

## 撤销与重做

- `Ctrl+Z` 撤销，`Ctrl+Y` 重做；只有没有 Shift/Alt/Meta、焦点不在可编辑控件且没有活动对话框时才响应。
- undo/redo 返回的完整载荷走与 dispatch 相同的“先投影、后保存”路径。
- 实例展开属于载荷修改，所以会进入历史；模板收起和图滚动位置是瞬时 UI 状态，不进入历史。

## 编辑结算（settle）

Shared Runtime 在远端变化等共享操作读取载荷前会调用控制器 hook：

- 没有活动草稿时返回 `null`。
- 活动草稿合法时，编辑器基于当前载荷构造事件，控制器先把该事件应用到自身 `#payload`，关闭对话框并重绘，再把事件交回 Runtime 纳入共享操作。
- 活动草稿无效时，控制器关闭对话框、丢弃草稿并提示已恢复保存前内容，不生成事件。
- Runtime 的 `project` hook 用于初始化、撤销/重做或共享投影，它会替换完整载荷、关闭活动编辑并全量重绘。

这意味着新增编辑器类型若拥有未提交草稿，必须实现可验证的 `settle(payload)`，否则远端变化可能跳过用户的有效输入。

## 同步操作门

Todos 的同步 UI 在以下情况阻止上传、拉取或冲突选择：

- 任意编辑器/管理对话框打开。
- 拖拽已激活或仍处于等待长按的 pending 状态。
- Runtime 快照仍为 `sessionDirty`，即本地保存尚未稳定。
- 控制器记录了本地保存失败。

页面在存在活动对话框、未保存会话或保存失败时也注册离开提醒。账号模式的云端修订轮询、上传/拉取和冲突方向选择由 Shared Runtime/`ModuleSyncUi` 实现，Todos 只负责操作前的门控、草稿结算和载荷投影。

## 主要实现链

模块规则在 `src/todos/definition.ts`，实体事件在 `domain/events.ts`，命令与保存结果规划在 `app/persistedCommands.ts`，控制器的 `#commit/#executeCommand/#settle/#guardSync` 负责接线，具体本地与云端生命周期来自 `src/shared/module/` 和 `src/shared/ui/ModuleSyncUi.ts`。
