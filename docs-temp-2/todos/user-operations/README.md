# Todos 用户操作逻辑总览

本目录按用户能触发的行为拆分操作链路。页面看起来是“列表 + 对话框 + 任务图”，但业务写入统一收敛到 `TodosController.#commit`。

## 页面入口与主要操作面

页面启动时，`main.ts` 创建 `TodosController`，再用 `todosDefinition` 启动 Shared Runtime；Runtime 初始化完成后把初始 `TodosPayload` 交给控制器，控制器渲染实例列表、周期模板管理器入口和同步状态。

用户主要通过四类操作改变状态：

- 在“添加待办”或任务标题打开实例编辑器，以草稿方式改名称、日期和子任务结构。
- 在卡片/任务图中直接勾选叶任务、展开实例、右键删除子任务或拖动依赖组，这些操作不经过长生命周期草稿。
- 在“周期待办”管理器中新建、编辑或删除模板，并由模板生成实例。
- 用 `Ctrl+Z`、`Ctrl+Y` 或同步控件触发 Shared Runtime 的历史与同步操作。

## 两类写入路径

### 编辑器草稿路径

```text
打开编辑器
  -> 深拷贝 baseline/draft
  -> 在内存草稿中改名称、日期、结构、权重或周期
  -> buildNext(current payload)
  -> validateTodosPayload
  -> controller.#commit(next payload)
  -> createTodosEvent(before, after)
  -> Runtime dispatch + UI projection + local save
```

切换到更深的子任务编辑器时，当前表单会先 `finalizeDraft`，验证并把尚未保存的上层编辑带入新的草稿；它不会提前写入 Runtime。取消整个编辑器则丢弃草稿。

### 列表/图上的即时命令路径

```text
用户动作
  -> 领域函数产生新的 instance/rule/root
  -> 拼成新的 TodosPayload
  -> controller.#commit
  -> 与草稿保存相同的事件、投影、保存链路
```

勾选、实例展开和拖拽成功后可采用局部 DOM 投影；新增、删除和编辑器保存通常全量重绘。

## 操作到专题的映射

| 操作 | 状态落点 | 专题 |
| --- | --- | --- |
| 新建/编辑/删除实例 | `payload.instances` | [`instances.md`](./instances.md) |
| 新增并列/递进子任务、删子树、拖动依赖组 | `TodoTask.children` / `predecessorId` | [`task-structure.md`](./task-structure.md) |
| 勾选任务、进度与完成时间 | `TodoTask.completed` / 派生值 / `completedAt` | [`task-structure.md`](./task-structure.md) |
| 设置提醒或截止、卡片状态和排序 | `reminderAt` / `deadlineAt` / 派生状态 | [`dates-status-order.md`](./dates-status-order.md) |
| 新建/修改/删除模板与自动生成 | `payload.rules`，有时同时新增实例 | [`recurring-templates.md`](./recurring-templates.md) |
| 撤销、重做、自动保存、重试、上传、拉取 | Runtime/历史/同步快照 | [`persistence-history-sync.md`](./persistence-history-sync.md) |

## UI 状态与业务状态不要混淆

- 实例的 `expanded` 属于持久化业务载荷，因此展开/收起也会进入历史并触发保存。
- 周期模板的收起集合、实例图和模板图的横向滚动位置只存在于控制器内存中，不写入 `todos.json`。
- 编辑器的 `busy`、选中的直接子任务、确认框和日期子对话框都是瞬时 UI 状态。
- 任务状态、进度和列表排序是从业务载荷与当前时间派生的展示，不应另建第二份可漂移状态。
