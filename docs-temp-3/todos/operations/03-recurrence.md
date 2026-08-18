# 周期模板与实例生成

本部分描述周期模板如何产生普通待办实例。模板保存结构和生成位置，实例保存实际执行状态；生成后两者默认独立演化。

## 周期与模板

周期规则的 `cadence`（生成周期）只有两种取值：

- `weekly` 的周期从本地时间周一 00:00 开始，到下一周周一 00:00 结束。
- `monthly` 的周期从本地时间每月一日 00:00 开始，到下一月一日 00:00 结束。

模板使用 `TodoTask` 树描述名称、层级、依赖和权重，但所有节点都保持未完成。用户编辑模板根任务时可以修改模板名称和 cadence；编辑模板子任务时可以修改名称、权重和下级结构。

## 生成游标

每条规则分别保存 `generatedThrough.weekly` 和 `generatedThrough.monthly`。游标记录对应 cadence 已经生成到哪个周期的开始时间，使规则在切换 cadence 后仍能识别两类周期各自的生成位置。

对当前 cadence，生成过程分为三种情况：

| 游标状态 | 生成结果 |
| --- | --- |
| 游标为 `null` | 生成当前周期的一个实例，并把游标推进到当前周期。 |
| 游标早于当前周期 | 从游标的下一个周期开始，逐个补齐到当前周期，并推进游标。 |
| 游标已到达当前周期 | 不生成实例。 |

首次保存新模板会初始化当前周期。修改现有模板的 cadence 也会初始化目标 cadence，但目标 cadence 的游标已经覆盖当前周期时不会重复生成。

运行时挂接完成、窗口重新获得焦点、页面重新可见以及最近周期边界到达时，控制器都会检查缺失周期。规则已有游标时会补齐离线期间跨过的每个周期；从未生成过的规则只从当前周期开始，不回填创建前的历史周期。

## 生成实例

每个周期实例具有以下稳定关系：

- `reminderAt` 是周期开始，`deadlineAt` 是下一个周期开始。
- `createdAt` 是实际生成时间，`sourceRuleId` 与 `sourcePeriodKey` 标记来源规则和周期。
- 模板任务树被深复制，所有任务获得新 ID，所有完成状态清空，实例初始为收起状态。
- 模板的后续编辑不回写已经生成的实例，实例的普通编辑也不回写模板。

生成游标记录的是“这个周期已经生成”，不是当前实例是否仍存在。用户删除周期实例不会回退游标，也不会使相同周期的实例自动重新生成。

## 模板覆盖与删除

来源规则仍存在时，周期实例的根编辑器可以在保存实例的同时覆盖模板。覆盖过程复制当前实例的整棵任务树，重新分配任务 ID，并清除完成状态；规则 ID、cadence、创建时间和生成游标保持不变。

删除模板会停止后续生成，但已经生成的实例保留。删除模板子任务只影响模板的未来结构，不修改已有实例。

## 相关代码

- [`src/todos/domain/recurrence.ts`](../../../src/todos/domain/recurrence.ts) 定义本地周月周期、实例克隆、游标初始化、缺失周期补齐和下个边界计算。
- [`src/todos/domain/types.ts`](../../../src/todos/domain/types.ts) 定义 cadence、双游标、周期规则以及实例的来源字段。
- [`src/todos/domain/tasks.ts`](../../../src/todos/domain/tasks.ts) 在模板生成或覆盖时深复制任务树、重分配 ID，并清除完成状态。
- [`src/todos/ui/recurrenceEditor.ts`](../../../src/todos/ui/recurrenceEditor.ts) 管理模板草稿，并在新建或 cadence 改变时把当前周期实例加入同一提交。
- [`src/todos/ui/instanceEditor.ts`](../../../src/todos/ui/instanceEditor.ts) 实现周期实例的普通保存与“保存并覆盖周期模板”分支。
- [`src/todos/app/controller.ts`](../../../src/todos/app/controller.ts) 打开周期模板管理器，并在启动、焦点、可见性和边界定时器上触发周期检查。
- [`tests/todos/recurrence.test.ts`](../../../tests/todos/recurrence.test.ts) 验证本地周期边界、单次初始化、漏期补齐和游标推进。
- [`tests/todos/recurrenceEditor.test.ts`](../../../tests/todos/recurrenceEditor.test.ts) 验证模板编辑、cadence 切换生成和模板删除流程。
