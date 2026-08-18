# Todos 模块：AI 入口

当需求涉及待办列表、任务完成、子任务结构、任务占比、提醒/截止日期、周期待办、撤销重做或待办同步时，先读本页获得全局印象，再按“需求路由”进入对应专题。

## 一句话定位

`todos` 不是简单的勾选清单，而是一个把每个待办表示为递归任务树、允许同一父任务下建立线性递进链、按权重推导进度，并能由每周或每月模板生成独立实例的持久化模块。

首页对它的产品描述是“用递进任务、周期规则和加权进度管理复杂事项”，模块入口为 `modules/todos/`，业务数据的稳定模块 ID 是 `todos`。

## 核心概念

| 概念 | 代码类型 | 含义 |
| --- | --- | --- |
| 待办实例 | `TodoInstance` | 用户实际完成的一项待办，拥有日期、完成时间、展开状态和一棵任务树。 |
| 任务节点 | `TodoTask` | 递归树节点；叶节点保存完成布尔值，非叶节点的完成状态由全部后代推导。 |
| 递进关系 | `predecessorId` | 只允许引用同一父节点下的另一个任务，并组成不分叉、无环的线性链。 |
| 周期模板 | `TodoRecurrenceRule` | 保存每周或每月的任务树模板及各周期的生成游标。 |
| 模块载荷 | `TodosPayload` | `{ instances, rules }`，是校验、事件、历史、持久化和同步的共同状态边界。 |
| 业务事件 | `TodosEvent` | 对实例数组和规则数组的一组实体级前后值/索引变更，可应用也可反转。 |

## 分层印象

- `domain` 是规则核心：数据类型、严格校验、任务树操作、日期状态、周期生成、事件和编解码都在这里，且函数以不可变更新为主。
- `app` 是用例编排：`TodosController` 把页面操作、编辑器草稿、运行时命令、局部渲染和周期调度串起来，`persistedCommands` 则明确区分“命令已接受”和“随后保存成功”。
- `ui` 是 DOM 组件：编辑对话框只拥有草稿和表单状态，图视图只投影一棵任务树，拖拽/平移组件只产生语义意图，不直接修改 `TodosPayload`。
- Shared Runtime 提供单编辑器租约、IndexedDB 本地存储、最多 200 步历史、云端同步及冲突处理；`todos` 通过模块 definition 和 hooks 接入。

## 需求路由

| 需求关键词 | 先读 |
| --- | --- |
| 新建、编辑、删除待办；展开；从模板实例回写模板 | [`user-operations/instances.md`](./user-operations/instances.md) |
| 子任务、并列/递进、完成锁、级联重置、任务占比、进度、拖拽 | [`user-operations/task-structure.md`](./user-operations/task-structure.md) |
| 提醒、截止、状态颜色/排序、日期输入 | [`user-operations/dates-status-order.md`](./user-operations/dates-status-order.md) |
| 周期模板、每周/每月生成、补生成、游标 | [`user-operations/recurring-templates.md`](./user-operations/recurring-templates.md) |
| 保存失败、撤销/重做、同步、冲突、远端变化时的编辑结算 | [`user-operations/persistence-history-sync.md`](./user-operations/persistence-history-sync.md) |
| 想快速定位实现或测试文件 | [`code-map.md`](./code-map.md) |
| 尚不确定需求属于哪条链路 | [`user-operations/README.md`](./user-operations/README.md) |

## 修改时先守住的系统不变量

1. 所有实例、规则和任务 ID 在整个 `TodosPayload` 内全局唯一，且必须是规范 UUID。
2. 根任务的 `weight` 固定为 `-1`；非根任务的权重只能是自动值 `-1` 或 `0..1`。
3. 非叶任务不直接存完成状态；实例的 `completedAt !== null` 必须与根任务推导完成完全一致。
4. 一个任务最多有一个直接后继，`predecessorId` 只能指向同级任务，递进关系不能分叉或成环。
5. 模板节点永远不存完成状态；生成实例时会深拷贝任务树、重建全部任务 ID 并清空完成状态。
6. 所有持久化业务修改最终都应形成一个合法 `TodosPayload`，再由前后载荷生成 `TodosEvent` 交给 Runtime，而不是让 UI 直接改历史或存储。
7. Runtime 已接受的命令不会因为紧随其后的本地保存失败而回滚；失败由持续可见的重试状态处理。

## 推荐的 AI 工作顺序

1. 用上表定位专题，并确认变更影响的是领域不变量、控制器编排、编辑器草稿还是纯展示。
2. 若新增业务规则，优先把纯逻辑放入 `src/todos/domain/`，再让编辑器或控制器调用，避免把规则复制进 DOM 组件。
3. 若修改保存链路，维持“构造候选载荷 → 严格校验 → 创建可逆事件 → Runtime 接受 → 投影 UI → 保存”的顺序。
4. 先补最接近规则的领域测试，再补编辑器/视图交互测试；文件职责可在 [`code-map.md`](./code-map.md) 中查找。

## 文档边界

这些文档重点记录需要跨文件才能看清的稳定逻辑；具体校验文案、焦点恢复、动画时长、DOM class 和一次性防御分支不在这里逐项复制，相关需求应继续读当前源码与测试。
