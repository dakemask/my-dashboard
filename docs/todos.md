# Todos 模块

## 概览

Todos 是待办管理模块。它管理普通待办实例、周期模板以及由模板生成的待办实例；每一项待办都可以继续拆成任务树，并在同一层级内表达先后依赖和进度权重。

Todos 自身负责业务模型、事件、编辑流程和页面投影，本地保存、撤销重做、远端同步与冲突处理接入 Shared 提供的模块运行时。远端业务内容编码为 `todos.json`。

## 核心模型

当前 schema 版本为 1，业务 payload 的真实结构是：

```ts
type TodoCadence = "weekly" | "monthly";

interface TodosPayload {
  readonly instances: readonly TodoInstance[];
  readonly rules: readonly TodoRecurrenceRule[];
}

interface TodoInstance {
  readonly id: string;
  readonly createdAt: string;
  readonly reminderAt: string;
  readonly deadlineAt: string | null;
  readonly completedAt: string | null;
  readonly expanded: boolean;
  readonly sourceRuleId: string | null;
  readonly sourcePeriodKey: string | null;
  readonly root: TodoTask;
}

interface TodoRecurrenceRule {
  readonly id: string;
  readonly createdAt: string;
  readonly cadence: TodoCadence;
  readonly template: TodoTask;
  readonly generatedThrough: TodoGenerationCursor;
}

interface TodoGenerationCursor {
  readonly weekly: string | null;
  readonly monthly: string | null;
}

interface TodoTask {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
  readonly completed: boolean;
  readonly predecessorId: string | null;
  readonly children: readonly TodoTask[];
}
```

`TodoInstance` 是用户实际执行的待办，包含时间、来源信息和一棵任务树。普通待办没有来源；周期实例记录生成它的规则与周期。

`TodoRecurrenceRule` 是生成实例的模板。规则包含 `weekly` 或 `monthly` 周期、一棵模板任务树，以及分别对应两种周期的生成游标。规则和实例共享同一种 `TodoTask` 结构，但模板不保存完成状态；生成实例时会复制整棵模板树，替换所有任务 ID，并清空完成状态。因此，已生成实例是独立快照，后续模板修改不会追溯改变它们。

实例编辑器允许把某个周期实例的当前结构显式覆盖回来源模板。这个操作会先清除完成状态，再用新 ID 构造模板树，同时更新实例和规则。删除周期规则只停止后续生成，已经生成的实例仍然保留。

整个 payload 作为一个聚合统一校验，实例、规则、任务标识和来源关系在同一边界内保持一致。

## 任务树中的拆解、依赖与进度

任务树同时表达三种关系：父子关系表示拆解，兄弟顺序表示展示顺序，`predecessorId` 表示同层串行依赖。同层任务由此形成若干线性依赖组，排序时依赖组作为整体移动。

完成状态以叶子任务为事实来源。叶子在 `completed` 中保存状态，非叶任务的完成状态由全部子任务递归推导，实例的 `completedAt` 必须与根任务的推导结果一致。模板中的所有节点都不保存完成状态。

叶子完成时会检查从根到叶子的各层前置依赖。较早任务重新变为未完成，或结构变化使它不再完成时，后继链中的完成状态会随之清除，使依赖顺序与完成状态保持一致。

进度从任务树递归计算：叶子进度为 0 或 1，父任务按子任务权重汇总。权重同时支持固定值和自动分配，结构变化后由 domain 重新维持依赖与权重有效性。

## 时间状态与列表顺序

待办状态不存入 payload，而是根据当前时间和任务树实时推导，共有四种：

- `overdue`：任务未完成，且已到截止时间。
- `reminded`：任务未完成，已到提醒时间，但尚未截止或没有截止时间。
- `pending`：任务未完成，且尚未到提醒时间。
- `completed`：任务树已经完成；这一状态优先于时间判断。

列表按上述状态分组，并在组内按对应时间排序。

业务时间以 UTC ISO 字符串保存，日期输入和周期边界按浏览器本地时间解释。实例展开状态属于 payload，周期模板管理器的折叠状态属于页面期状态。

## 周期生成

周期边界按本地周或本地月计算。生成的实例使用周期起点和下一周期起点作为时间范围，并记录来源周期键。

规则为 `weekly` 和 `monthly` 分别保存生成游标。新建或切换周期时初始化当前周期，后续检查从游标之后补齐到当前周期。

生成检查在运行时接入后和页面重新活跃时执行。实例生成与游标推进在同一次 payload 修改中提交。

## 事件模型

Todos 当前只有一种业务事件：

```ts
interface TodosEvent {
  readonly type: "change-entities";
  readonly instances: readonly TodoEntityChange<TodoInstance>[];
  readonly rules: readonly TodoEntityChange<TodoRecurrenceRule>[];
}

interface TodoEntityChange<T> {
  readonly id: string;
  readonly before: T | null;
  readonly after: T | null;
  readonly beforeIndex: number;
  readonly afterIndex: number;
}
```

事件分别记录实例和规则的实体变更，一次事件可以原子地同时改变两者。模块使用容量为 200 的单一页面会话历史，而不是为任务节点分别建立命令历史。

任务树内部修改先形成新的完整 payload，再由前后 payload 计算实体变更；逆事件通过交换变更前后状态得到。

控制器提交事件、撤销或重做后，先采用运行时返回的 payload 更新页面，再执行本地保存。运行时已接受的修改不会因为随后保存失败而回滚；控制器会保留当前页面内容，进入本地保存失败状态并提供重试。同步操作会在编辑对话框、拖动操作、未完成的运行时保存或本地保存失败期间被阻止。

编辑器只拥有表单和草稿。保存时由编辑器构造候选 payload，控制器负责校验、生成事件和持久化；Shared 要求结算或投影时，控制器统一结束当前编辑。

## 页面投影与交互组件

`TodosController` 汇合运行时 payload、同步快照、编辑器和临时交互状态，并把业务修改收敛到同一提交路径。实例编辑器和规则编辑器复用任务结构编辑器；卡片和模板预览共用只负责投影的任务图。

## 代码入口

- `src/todos/definition.ts`：模块定义。
- `src/todos/domain/`：payload、任务与周期规则、事件和编解码。
- `src/todos/app/`：页面编排及业务修改的提交路径。
- `src/todos/ui/`：实例与规则编辑器、任务结构和任务图。
