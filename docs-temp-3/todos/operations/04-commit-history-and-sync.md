# 提交、历史与同步

本部分描述用户修改如何从编辑草稿变成运行时状态，再进入本地保存和云端同步。Todos 把“命令已应用”与“本地保存成功”视为两个连续但不同的阶段。

## 草稿与事件事务

实例编辑器和模板编辑器各自持有完整草稿，不直接持有运行时。保存时，编辑器先把当前字段合并进草稿并校验出下一个 `TodosPayload`，控制器再比较当前 payload 与下一个 payload，生成一个 `change-entities` 事件。

事件分别列出实例和规则的实体变化。每项变化携带 ID、前后实体值以及前后集合索引，所以一次事件可以原子地完成新增、删除、替换和重排，也可以同时修改实例与模板。周期模板首次保存、cadence 改变和实例覆盖模板都依赖这种跨集合事务。

前后 payload 没有语义差异时不派发历史事件，只刷新当前投影和命令状态。

## 命令与保存状态

派发、撤销和重做共用同一条执行顺序：运行时先应用命令并返回新 payload，页面立即投影这个 payload，然后调用本地保存。

执行结果有三种状态：

| 状态 | 页面与运行时结果 |
| --- | --- |
| `command-failed` | 命令没有应用，页面不投影新值，也不继续保存。 |
| `saved` | 命令已应用，新 payload 已投影并保存到本机。 |
| `save-failed` | 命令已应用且新 payload 保留在当前会话，但本地持久化失败。 |

`save-failed` 不回滚已接受的命令。页面持续显示当前内容和保存失败状态，用户可以单独重试保存；后续任一命令连同保存成功后也会清除该失败状态。

页面在存在活动编辑器、运行时仍有未保存会话修改或最近一次本地保存失败时提示离页风险。

## 撤销与重做

模块定义保留最多 200 条页面生命周期事件。事件包含完整前后实体与索引，反转时交换前后值和索引，因此新增、删除、内容编辑、集合顺序和实例展开状态都可以撤销重做。

页面使用 `Ctrl+Z` 撤销、`Ctrl+Y` 重做。焦点位于可编辑控件或存在活动对话框时，快捷键不接管编辑行为。撤销和重做完成后与普通命令一样立即投影，并尝试保存到本机。

## 活动编辑与共享运行时

共享运行时在保存、同步、远端变化或历史操作前可以要求模块结算活动交互。Todos 对有效草稿生成事件并关闭编辑器；草稿无法通过校验时，编辑器关闭且页面恢复为最近一次有效 payload。运行时投影初始化、撤销或重做结果时也会关闭现有编辑器后重建页面。

页面发起上传或拉取前有两层门控：

- 存在活动编辑器，或依赖组拖动处于等待或进行状态时，同步动作不开始。
- 当前会话仍待本地保存，或本地保存失败尚未恢复时，同步动作不开始。

账户模式下的上传、拉取和冲突选择由共享同步界面执行；Todos 只提供上述交互结算和门控，并在新 payload 投影后重建本模块界面。

## 存储边界

Todos schema 当前为版本 `1`。编解码器只管理一个 `todos.json`，写出前校验完整 payload，读取后再由模块定义进行业务校验。共享运行时负责 IndexedDB、本地内容哈希、账户模式远端仓库和编辑租约。

## 相关代码

- [`src/todos/app/persistedCommands.ts`](../../../src/todos/app/persistedCommands.ts) 定义命令应用、页面投影、本地保存和三种执行结果之间的顺序。
- [`src/todos/app/controller.ts`](../../../src/todos/app/controller.ts) 生成提交事件、维护活动草稿、执行撤销重做、处理保存失败并实现同步门控。
- [`src/todos/domain/events.ts`](../../../src/todos/domain/events.ts) 创建、校验、应用和反转实例与规则的实体差异事务。
- [`src/todos/definition.ts`](../../../src/todos/definition.ts) 配置 schema 版本、事件应用与反转函数以及 200 条历史容量。
- [`src/todos/domain/codec.ts`](../../../src/todos/domain/codec.ts) 把完整业务状态严格编解码为唯一的 `todos.json`。
- [`src/shared/module/runtimeTypes.ts`](../../../src/shared/module/runtimeTypes.ts) 定义模块运行时命令、生命周期状态以及结算和投影钩子。
- [`src/shared/module/DefaultModuleRuntime.ts`](../../../src/shared/module/DefaultModuleRuntime.ts) 串行化保存与同步命令并把 Todos 连接到共享协调器。
- [`src/shared/sync/SyncCoordinator.ts`](../../../src/shared/sync/SyncCoordinator.ts) 在共享操作前结算模块交互，并管理历史、本地状态与远端状态。
- [`src/shared/ui/moduleSyncActions.ts`](../../../src/shared/ui/moduleSyncActions.ts) 实现上传、拉取和冲突方向选择的共享用户流程。
- [`tests/todos/persistedCommands.test.ts`](../../../tests/todos/persistedCommands.test.ts) 验证命令成功、命令失败和保存失败时的投影与状态规划。
- [`tests/todos/events.test.ts`](../../../tests/todos/events.test.ts) 验证混合实体事务的差异、应用、反转和过期索引拒绝。
- [`tests/todos/codec.test.ts`](../../../tests/todos/codec.test.ts) 验证模块 ID、schema、唯一托管文件和稳定 JSON 往返。
