# Todos 模块

本页是 AI 处理 Todos 需求时的模块入口。它说明模块解决的问题、核心数据和代码分层；具体用户操作按需求进入后面的专题文档。

## 模块概览

Todos 是独立的待办模块，页面入口为 `modules/todos/index.html`，模块标识为 `todos`。它同时管理两类业务对象：用户实际执行的待办实例，以及按周或按月生成实例的周期模板。

一个待办实例以根任务代表整项待办，根任务下面可以递归组织子任务。同一父任务下的子任务既可以并列，也可以通过前置关系组成线性依赖链。实例还保存提醒时间、可选的截止时间、完成时间和任务图展开状态。

周期模板使用相同的任务树结构，但不保存完成进度。模板在本地时间的周或月边界生成独立实例，已经生成的实例之后可以脱离模板单独编辑。

模块数据由共享运行时负责本地持久化、撤销重做和账户模式下的云端同步。Todos 自己负责业务校验、事件生成、编辑草稿和页面投影。

## 核心对象

- `TodosPayload` 是模块的完整业务状态，只包含 `instances` 和 `rules` 两个有序集合。
- `TodoInstance` 是可执行的待办实例，任务内容位于 `root`，周期来源由 `sourceRuleId` 与 `sourcePeriodKey` 共同标记。
- `TodoRecurrenceRule` 是周期规则，包含 `weekly` 或 `monthly` 周期、任务模板和两个周期各自的生成游标。
- `TodoTask` 是递归任务节点；`children` 表示层级，`predecessorId` 表示同级前置任务，`weight` 表示进度权重。
- `TodosEvent` 是实例集合与模板集合之间的实体差异事务，供运行时派发和历史反转使用。

整个 payload 内的实例、规则和任务节点共用一个 ID 空间。时间写入数据时使用规范 UTC ISO 字符串，周期边界和用户日期输入按浏览器本地时间解释。

## 代码分层

- 领域层 `src/todos/domain/` 定义数据结构、校验、任务树规则、日期状态、周期生成、事件和 JSON 编解码。
- 应用层 `src/todos/app/` 连接用户动作、编辑草稿、领域命令和共享运行时。
- 界面层 `src/todos/ui/` 提供页面壳、编辑对话框、任务图、结构编辑器、拖动和图形平移。
- `src/todos/definition.ts` 把 Todos 注册为共享 JSON 模块，并配置 200 条页面生命周期历史记录。
- `src/todos/main.ts` 启动共享模块运行时并把初始 payload 交给 `TodosController`。

## 用户操作文档

- [待办实例、日期与列表状态](operations/01-instances-and-dates.md)：新建、编辑、删除、完成、日期关系、状态与排序。
- [任务结构、依赖与进度](operations/02-task-structure-and-progress.md)：子任务树、并列与递进、依赖组、完成传播和权重。
- [周期模板与实例生成](operations/03-recurrence.md)：周期边界、生成游标、补生成、模板覆盖和删除语义。
- [提交、历史与同步](operations/04-commit-history-and-sync.md)：草稿结算、事件事务、自动保存、撤销重做和同步门控。

## 模块入口代码

- [`modules/todos/index.html`](../../modules/todos/index.html) 提供 Todos 的独立 HTML 入口并加载模块样式与启动脚本。
- [`src/todos/main.ts`](../../src/todos/main.ts) 启动共享运行时、处理启动结果并挂接控制器。
- [`src/todos/definition.ts`](../../src/todos/definition.ts) 定义模块 ID、schema 版本、校验、事件历史和编解码策略。
- [`src/todos/app/controller.ts`](../../src/todos/app/controller.ts) 统筹页面投影、编辑器、任务图、领域命令和运行时钩子。
- [`src/todos/domain/types.ts`](../../src/todos/domain/types.ts) 集中定义实例、模板、任务、事件和列表状态的数据类型。
