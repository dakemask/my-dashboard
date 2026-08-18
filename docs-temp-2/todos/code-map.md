# Todos 代码文件地图

以下只列对 Todos 有直接职责的文件和最关键的 Shared 接入点，不展开每一个传递依赖；每个文件用一句话说明，改动前再打开当前源码确认细节。

## 页面与模块接入

- [`modules/todos/index.html`](../../modules/todos/index.html) — 提供 Todos 独立页面、CSP、样式入口和 `main.ts` 挂载点。
- [`src/home/modules.ts`](../../src/home/modules.ts) — 在首页模块目录与首次账号持久化定义中注册 Todos。
- [`src/todos/main.ts`](../../src/todos/main.ts) — 创建控制器、启动 Shared Runtime、挂接初始载荷并处理启动失败。
- [`src/todos/definition.ts`](../../src/todos/definition.ts) — 声明模块 ID、schema 版本、空载荷、200 步历史策略及 JSON 编解码。

## 应用编排

- [`src/todos/app/controller.ts`](../../src/todos/app/controller.ts) — 统一编排页面事件、编辑器、领域更新、渲染、Runtime 命令、同步门控和周期调度。
- [`src/todos/app/persistedCommands.ts`](../../src/todos/app/persistedCommands.ts) — 把 dispatch/undo/redo 与随后的本地保存分成可测试的结果状态。

## 领域模型

- [`src/todos/domain/types.ts`](../../src/todos/domain/types.ts) — 定义任务、实例、周期规则、载荷、实体变更事件和派生状态的稳定类型。
- [`src/todos/domain/validationPrimitives.ts`](../../src/todos/domain/validationPrimitives.ts) — 提供精确对象形状、数组、UUID 和事件索引的底层严格校验器。
- [`src/todos/domain/validation.ts`](../../src/todos/domain/validation.ts) — 校验并规范化完整载荷，维护全局 ID、完成时间、来源配对、权重和同级依赖链不变量。
- [`src/todos/domain/tasks.ts`](../../src/todos/domain/tasks.ts) — 实现任务树查询、完成门、级联重置、结构增删、依赖组重排、权重分配和递归进度。
- [`src/todos/domain/dates.ts`](../../src/todos/domain/dates.ts) — 实现日期解析/协调、相对日期、实例状态推导和列表排序。
- [`src/todos/domain/recurrence.ts`](../../src/todos/domain/recurrence.ts) — 计算本地周/月周期、克隆生成实例、推进游标、补齐遗漏周期和寻找下个边界。
- [`src/todos/domain/events.ts`](../../src/todos/domain/events.ts) — 生成、严格应用和反转包含实例/规则实体前后值与索引的事务事件。
- [`src/todos/domain/codec.ts`](../../src/todos/domain/codec.ts) — 将合法载荷稳定编码为唯一的 `todos.json` 并从该文件解码 JSON。
- [`src/todos/domain/model.ts`](../../src/todos/domain/model.ts) — 保留旧导入路径的兼容 facade，并把调用转发到拆分后的语义模块。
- [`src/todos/domain/index.ts`](../../src/todos/domain/index.ts) — 汇总导出 Todos 领域 API。

## UI 组件

- [`src/todos/ui/shell.ts`](../../src/todos/ui/shell.ts) — 构造页面骨架、命令栏、列表挂载点、保存失败条和 toast 反馈。
- [`src/todos/ui/icons.ts`](../../src/todos/ui/icons.ts) — 为 Todos 封装 Shared IconPark SVG 创建器。
- [`src/todos/ui/editorDialog.ts`](../../src/todos/ui/editorDialog.ts) — 提供实例、模板和模板管理器共用的可访问对话框、busy 状态、错误和字段控件。
- [`src/todos/ui/confirmDialog.ts`](../../src/todos/ui/confirmDialog.ts) — 提供单实例、默认安全聚焦且可门控取消的确认对话框。
- [`src/todos/ui/dateEditor.ts`](../../src/todos/ui/dateEditor.ts) — 管理提醒/截止摘要与具体日期、相对天数选择对话框。
- [`src/todos/ui/instanceEditor.ts`](../../src/todos/ui/instanceEditor.ts) — 拥有实例编辑草稿，完成保存/删除/子任务导航及可选的来源模板覆盖事务。
- [`src/todos/ui/recurrenceEditor.ts`](../../src/todos/ui/recurrenceEditor.ts) — 拥有周期模板草稿，并在新建或 cadence 改变时把当前周期初始化纳入保存事务。
- [`src/todos/ui/taskStructureEditor.ts`](../../src/todos/ui/taskStructureEditor.ts) — 投影当前节点的直接子任务、选择与结构命令，并描述可拖动依赖组和连接线。
- [`src/todos/ui/taskGraphView.ts`](../../src/todos/ui/taskGraphView.ts) — 以 keyed DOM 投影实例/模板任务图，发出打开、勾选、右键删除、滚动和组重排意图。
- [`src/todos/ui/taskGraphConnections.ts`](../../src/todos/ui/taskGraphConnections.ts) — 计算并增量绘制任务图的父子连接和递进依赖 SVG 路径。
- [`src/todos/ui/pointerReorder.ts`](../../src/todos/ui/pointerReorder.ts) — 处理鼠标/触摸拖拽、长按、预览、自动滚动、恢复和语义提交。
- [`src/todos/ui/graphPanController.ts`](../../src/todos/ui/graphPanController.ts) — 处理图空白区的横向滚轮、鼠标/触摸平移、惯性和误点击抑制。

## 样式

- [`src/todos/style.css`](../../src/todos/style.css) — 按职责聚合 Todos 的五个 CSS 分片。
- [`src/todos/styles/base-shell.css`](../../src/todos/styles/base-shell.css) — 定义页面基础变量、整体布局、页头和通用按钮/空状态。
- [`src/todos/styles/cards.css`](../../src/todos/styles/cards.css) — 定义实例卡片、状态视觉、摘要、日期和进度条。
- [`src/todos/styles/task-graph.css`](../../src/todos/styles/task-graph.css) — 定义任务图层级、节点、依赖组、连接线、展开动画和拖动状态。
- [`src/todos/styles/editors.css`](../../src/todos/styles/editors.css) — 定义编辑器、字段、结构列表、日期/确认对话框和响应式布局。
- [`src/todos/styles/feedback.css`](../../src/todos/styles/feedback.css) — 定义本地保存失败提示和 toast 反馈。

## 关键 Shared 接入点

- [`src/shared/module/definition.ts`](../../src/shared/module/definition.ts) — 校验模块定义并为 JSON 载荷提供稳定 content key。
- [`src/shared/module/startModuleRuntime.ts`](../../src/shared/module/startModuleRuntime.ts) — 建立租约、本地存储、认证/远端仓库、同步协调器、轮询器和 Runtime 生命周期。
- [`src/shared/module/runtimeTypes.ts`](../../src/shared/module/runtimeTypes.ts) — 定义 Todos 控制器依赖的 Runtime 命令、快照 hooks 与启动结果契约。
- [`src/shared/module/DefaultModuleRuntime.ts`](../../src/shared/module/DefaultModuleRuntime.ts) — 串行执行保存/同步命令并把 dispatch、undo、redo 映射到同步协调器历史。
- [`src/shared/ui/ModuleSyncUi.ts`](../../src/shared/ui/ModuleSyncUi.ts) — 渲染手动云同步状态并在执行上传、拉取或冲突选择前调用 Todos 门控。

## 测试

- [`tests/todos/helpers.ts`](../../tests/todos/helpers.ts) — 提供稳定 UUID、任务、实例、规则和载荷测试工厂。
- [`tests/todos/validation.test.ts`](../../tests/todos/validation.test.ts) — 覆盖载荷规范化、精确字段、全局 ID、完成/来源配对、权重和依赖链校验。
- [`tests/todos/tasks.test.ts`](../../tests/todos/tasks.test.ts) — 覆盖深层完成门、级联重置、不可变结构操作、依赖组重排和权重进度。
- [`tests/todos/domain.test.ts`](../../tests/todos/domain.test.ts) — 以较高层组合场景回归任务链、完成、权重和事件反转。
- [`tests/todos/dates.test.ts`](../../tests/todos/dates.test.ts) — 覆盖日期输入、夹值、负数语义、日期协调、状态与排序。
- [`tests/todos/recurrence.test.ts`](../../tests/todos/recurrence.test.ts) — 覆盖本地周/月边界、当前周期单次初始化和遗漏周期补生成。
- [`tests/todos/events.test.ts`](../../tests/todos/events.test.ts) — 覆盖混合实体事务的差分、应用、反转和过期/冲突索引拒绝。
- [`tests/todos/codec.test.ts`](../../tests/todos/codec.test.ts) — 覆盖稳定模块定义、`todos.json` 往返及受管文件形状拒绝。
- [`tests/todos/persistedCommands.test.ts`](../../tests/todos/persistedCommands.test.ts) — 覆盖命令成功但保存失败时仍保留投影，以及重试状态规划。
- [`tests/todos/instanceEditor.test.ts`](../../tests/todos/instanceEditor.test.ts) — 覆盖实例草稿、日期、覆盖来源模板、busy 恢复和确认删除。
- [`tests/todos/recurrenceEditor.test.ts`](../../tests/todos/recurrenceEditor.test.ts) — 覆盖 cadence 变更生成、深层草稿传递、模板删除确认和新建取消。
- [`tests/todos/dateEditor.test.ts`](../../tests/todos/dateEditor.test.ts) — 覆盖日期 UI 的具体/相对选择、就地报错和安全取消。
- [`tests/todos/editorDialog.test.ts`](../../tests/todos/editorDialog.test.ts) — 覆盖对话框可访问结构、触发点恢复、busy 阶段和关闭门控。
- [`tests/todos/confirmDialog.test.ts`](../../tests/todos/confirmDialog.test.ts) — 覆盖确认框的安全按钮顺序、取消门控和焦点恢复。
- [`tests/todos/taskStructureEditor.test.ts`](../../tests/todos/taskStructureEditor.test.ts) — 覆盖直接子任务投影、语义命令、依赖组描述和增量连接线。
- [`tests/todos/taskGraphView.test.ts`](../../tests/todos/taskGraphView.test.ts) — 覆盖实例/模板共用图、keyed DOM、深层完成门、滚动恢复和连接增量重绘。
- [`tests/todos/pointerReorder.test.ts`](../../tests/todos/pointerReorder.test.ts) — 覆盖横纵拖动、整组移动、触摸长按、自动滚动和取消恢复。
- [`tests/todos/graphPanController.test.ts`](../../tests/todos/graphPanController.test.ts) — 覆盖空白区平移、触摸方向门、惯性、点击抑制和资源释放。
- [`tests/todos/shell.test.ts`](../../tests/todos/shell.test.ts) — 覆盖反馈时长、持久保存失败提示和图标按钮语义。
