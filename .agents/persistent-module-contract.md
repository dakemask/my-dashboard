# 持久化模块公共契约

本文供所有需要保存业务数据的模块长期使用。它解释模块怎样划分状态、怎样调用 Shared SDK，以及 SDK 对模块承诺的可观察行为。

## 1. 五层模型与数据边界

| 层 | 内容 | 寿命 |
| --- | --- | --- |
| 用户命令 | 用户此刻要完成的动作 | 一次命令 |
| 实时状态 | 草稿、焦点、选择、拖拽、动画和页面呈现状态 | 当前标签页 |
| 数据暂存 | 当前完整业务 payload 和可逆业务 event | 当前标签页 |
| 本地数据 | 最近成功保存到当前设备、当前 profile 的完整 payload | 跨刷新和浏览器重启 |
| 云端数据 | 用于跨设备同步的完整 payload | 跨设备 |

数据按下面的方向流动：

```text
编辑：用户命令 → 实时状态 → event → 暂存 payload
撤销/重做：暂存 event → 暂存 payload → 实时状态
保存：暂存 payload → 本地数据
上传：本地数据 → 云端数据
拉取：云端数据 → 本地数据 → 新页面会话
```

实时状态不能直接保存，暂存内容也不能绕过本地保存直接上传。系统元数据由 SDK 管理，不进入业务 payload 或 event。

### 完整 payload

payload 是模块全部业务数据的一份完整表示，不是 JSON 的同义词。只看 payload 就应能够恢复业务内容，不需要再从 DOM、历史或同步状态中补数据。

payload 必须：

- 能通过浏览器 `structuredClone` 和 IndexedDB 往返；
- 由模块提供的 `validate` 完整校验；
- 不包含焦点、选择、pointer、DOM、动画等实时状态；
- 不包含凭据、保存时间、revision、pending、conflict 等系统状态。

### 业务 schema 迁移

需要演进持久化格式的模块在模块定义中提供可选的 `migration` 策略。schema
版本属于 Shared 管理的模块快照元数据：本地保存在 IndexedDB envelope，云端保存
在 `revision.json.schemaVersion`，不进入业务 payload、event、content key 或受管
业务文件。

- `currentVersion` 是当前代码产生和接受的正整数版本；
- `migrate(value, fromVersion)` 把 payload 迁移一个版本；Runtime 根据 envelope 或
  `revision.json` 提供的来源版本逐版调用，直到 `currentVersion`；
- 每一步迁移必须确定、无副作用、不修改输入，并完整校验其源版本；
- `validate`、`contentKey` 和 `encode` 只处理迁移完成后的当前版本；
- `decode` 只把远端文本解析为未知版本的原始值，不得提前只接受当前版本。

Shared 不理解模块字段和迁移语义，只负责克隆、按序调用、最终校验、原子保存和
同步状态。版本化模块缺少明确 schemaVersion、高于 `currentVersion`、版本无效或
迁移异常时必须停止，不得把缺失版本猜测为 v1，也不得覆盖原始本地记录。已有模块
首次接入版本化时，由用户明确把当前云端数据标记为初始版本，并清理或显式转换旧
本地数据。

确实使用 JSON 兼容 payload 的模块使用 `defineJsonModule`。需要 `Map`、`Set`、`Date`、`ArrayBuffer`、类型化数组或其他可 structured-clone 数据的模块使用 `defineModule`，并自行提供稳定的 `contentKey`。函数、DOM 引用、`WeakMap` 等不能可靠持久化的值不得进入 payload。

### 模块定义

每个模块提供一份稳定的定义：

- 唯一且长期不变的 `moduleId`，格式为小写字母、数字和单连字符；
- `createEmpty()` 和 `validate(payload)`；
- 能完整反映业务语义的 `contentKey(payload)`；
- event 历史策略；
- payload 与远端受管文本文件之间的 `encode`/`decode`。
- 如需格式演进，提供模块 `migration` 策略；版本元数据由 Shared 保存。

相同业务内容必须产生相同 content key 和相同受管文件；任何需要保存或同步的业务变化都必须改变 content key。远端文件可以是 JSON、Markdown、YAML、CSV 或模块自定义的 UTF-8 文本格式。

## 2. 暂存、撤销与重做

数据暂存层始终持有当前完整 payload。历史记录的是可逆 event，不是每一步 payload 快照；event 历史只存在于当前页面会话，刷新后由本地 payload 建立一条空队列。

模块为每种 event 提供：

- `apply(payload, event)`：得到变化后的完整 payload；
- `invert(event, before, after)`：得到能恢复 `before` 的反向 event；
- 正整数或 `"unlimited"` 的 `history.capacity`。

`apply`、`invert`、`validate` 和 `contentKey` 必须确定、无副作用且不修改输入。一次用户能够理解的完整动作通常对应一个 event；拖动过程、输入过程或 DOM event 不应逐个进入历史。

模块通过以下接口操作暂存层：

| 接口 | 用途 |
| --- | --- |
| `runtime.dispatch(event)` | 提交一个已经完成的业务动作 |
| `runtime.undo()` | 结算实时交互后撤销一步 |
| `runtime.redo()` | 结算实时交互后重做一步 |
| `runtime.current` | 读取当前完整 payload 的隔离副本 |
| `runtime.canUndo` / `canRedo` | 判断按钮或菜单是否可用 |
| `runtime.dirty` | 判断当前 payload 是否偏离最近本地保存基线 |

语义上没有改变 payload 的 event 不入队，也不删除已有 redo。撤销后提交真实新变化会删除旧 redo 分支。保存不清空历史；撤销或重做到本地保存基线时，`dirty` 自动恢复为 false。

### `settle` 与 `project`

实时交互不能被公共命令直接带入历史或持久化。模块必须实现：

- `settle(reason)`：在保存、上传、拉取、远端变化、撤销和重做前，提交或取消尚未完成的实时交互；返回至多一个 event，没有变化时返回 `null`。
- `project(payload, reason)`：在初始化、撤销和重做后，把完整 payload 投影到页面，并清理已经失效的草稿、选择和 pointer 状态。

如一次结算确实包含多个不可分割的业务变化，模块应把它们表示成一个复合 event，而不是绕过 runtime 修改 payload。

Shared 不注册 `Ctrl+Z`、`Ctrl+Y`、`Ctrl+S` 或其他业务快捷键。按钮、菜单、键位和监听清理由模块决定；它们只调用上述 runtime 功能。

## 3. 初始化与页面结束

模块页面用 `startModuleRuntime({ definition, appRoot, hooks })` 启动。SDK 从首页账户注册表取得启动时固定的 profile：没有账户时使用 `local` profile；账户模式使用当前账户 profile。SDK 取得该 profile 下该模块的单标签编辑权、读取本地数据，在账户模式首次使用时读取云端、本地模式首次使用时建立空数据，在需要时迁移并原子保存本地 payload、创建空历史，并在账户模式启动同步观察，最后调用 `project(payload, "initialize")`。

`runtime.mode` 为 `"local"` 或 `"account"`。账户切换只影响之后启动或刷新的页面；已经打开的 runtime 始终绑定启动时的 profile，不得中途改读其他账户的数据。本地 envelope、同步基线、pending、conflict 和编辑锁均按 `profileId + moduleId` 隔离。

本地迁移不推进同步基线。Runtime 持久化迁移变化，并区分它与用户业务修改。只有
纯迁移、没有既有冲突时，Runtime 才在启动后自动尝试非强制上传；临时失败后可由
后续 revision 轮询重试。存在同步前业务修改或既有冲突时不自动上传，等待用户按
现有同步流程处理。

启动结果只有四种：

| 状态 | 模块行为 |
| --- | --- |
| `ready` | 保存返回的 runtime，并进入可编辑页面 |
| `authentication-required` | 仅用于兼容认证注入边界；生产页面由首页账户设置管理账户 |
| `blocked` | 同模块已有另一个编辑标签；显示 SDK 提供的阻止页面 |
| `unsupported` | 浏览器缺少安全编辑锁；禁止编辑 |

初始化时的 `project` 只能依据传入 payload 建立页面，不能依赖尚未返回的 runtime。启动异常只能显示安全、可重试的模块文案，不得展示原始请求、响应或捕获异常。

普通页面关闭会触发 SDK 清理。模块在单页应用中被卸载时，应移除自己注册的监听并等待 `runtime.dispose()`；dispose 完成后不得继续使用该 runtime。

## 4. 本地保存、云端同步与冲突

### 本地保存

`runtime.save()` 先调用 `settle("local-save")`，再把当前完整 payload 原子保存到当前设备。保存期间应用根节点暂时不可操作，但不显示云端遮罩。

成功写入新版本后，本地保存基线和 `localSavedAt` 推进，历史仍然保留。失败时当前 payload、历史、dirty 和旧保存基线保持不变，页面恢复操作并允许重试。

### 上传与拉取

| 接口 | 用户意图 |
| --- | --- |
| `runtime.upload()` | 必要时先保存，再把本地完整 payload 上传到云端 |
| `runtime.pull()` | 检查云端版本；本地没有变化时拉取，双方变化时形成冲突 |
| `runtime.resolveConflict("local-wins")` | 明确用本地完整 payload 覆盖云端 |
| `runtime.resolveConflict("cloud-wins")` | 明确用云端完整 payload 覆盖本地 |
| `runtime.pollNow()` | 立即执行一次与后台轮询相同的版本检查；不是“刷新当前页面” |

上传、拉取和两个覆盖方向由 SDK 显示同一份全页 spinner 与模糊遮罩。模块页面使用 Shared 提供的 `ModuleSyncUi` 呈现保存和同步状态，不复制同步 UI，也不直接访问 GitHub。账户模式呈现上传、拉取、云端版本、冲突确认及同步结果；本地模式只呈现本机保存状态并隐藏云端操作。

模块在创建 `ModuleSyncUi` 时必须提供 `guardAction(action)` 业务门禁。Shared 在用户主动上传或拉取前调用它：

- `ready` 表示模块已准备好，Shared 继续标准同步流程；
- `blocked` 表示当前业务状态不允许同步，Shared 显示模块返回的安全说明并停止；
- 门禁只处理模块业务状态，不执行上传、拉取、覆盖确认或结果提示；
- `settle` 仍由 runtime 在实际持久化命令内部调用，门禁不能替代数据安全结算。

本地自动保存、保存失败反馈和“重试保存”仍由模块负责，不属于 `ModuleSyncUi`。

同步判断固定为：

| 云端变化 | 本地变化 | 结果 |
| --- | --- | --- |
| 否 | 否 | 保持一致 |
| 否 | 是 | 保留本地，等待用户上传 |
| 是 | 否 | 拉取云端到本地，并建立新页面会话 |
| 是 | 是 | 持久化冲突，不自动覆盖或合并 |

业务 schema 升级仍使用这四象限。多设备从同一旧版本独立迁移时，最先成功完成
非强制上传的设备自然发布新格式，不进行设备选举。其他仅有迁移变化的设备发现
云端变化后，拉取并按当前 schema 准备云端 payload：

- 云端已经是当前 schema 且规范化 content hash 与本地一致时，原子推进本地同步
  基线、清除 migration/pending 状态并直接确认同步，不上传、不刷新、不产生冲突；
- 云端仍是旧 schema、迁移结果不同、本地含业务修改或存在既有冲突时，不走等价
  快路径，继续使用当前四象限和冲突处理。

冲突可以跨刷新保留。模块只能让用户选择 `local-wins` 或 `cloud-wins`；不得自行自动合并或暗中选择方向。

`dirty === false` 只表示页面内容已经保存到本地，不表示已经上传。Shared 同步 UI 通过 `runtime.getSnapshot()` 和模块转发的 `onSnapshotChange(snapshot)` 区分：

- `sessionDirty`：页面内容尚未保存到本地；
- `localChangedSinceSync`：本地版本尚未同步；
- `businessChangedSinceSync`：本地存在尚未同步的业务修改；
- `migrationChangedSinceSync`：本地 schema 已升级但云端尚未确认相同格式；
- `localSavedAt`：本地版本时间；
- `knownRemoteRevision` / `knownRemoteUpdatedAt`：最近已知云端版本；
- `pendingUpload`：存在尚未确认结果的上传；
- `conflict`：存在尚未解决的冲突。

状态观察回调只更新 UI；即使回调自身失败，也不能改变已经完成的 runtime 操作。

## 5. 公共接口与开发约束

业务模块只从 `src/shared` 根入口导入。准确 TypeScript 签名以该入口导出的源码类型为准；这里记录用途，不复制整套类型定义。

| 类别 | 公共能力 |
| --- | --- |
| 定义 | `defineModule`、`defineJsonModule`、`jsonContentKey`、`ModuleDefinition`、`ModuleMigrationPolicy`、history policy/capacity |
| 启动 | `startModuleRuntime`、启动 options/result/state |
| runtime | `mode`、`current`、历史状态、`dispatch`、`undo`、`redo`、`save`、`upload`、`pull`、`resolveConflict`、`pollNow`、`getSnapshot`、`dispose` |
| hooks | `settle`、`project`、`onConflict`、`onSnapshotChange` |
| 同步 UI | `ModuleSyncUi`、`ModuleSyncAction`、`ModuleSyncGateResult`；模块提供挂载点和业务门禁 |
| 图标 UI | `createIconParkIcon`、`createIconOnlyButton`、`IconParkRenderer`；统一 IconPark SVG 解析和纯图标按钮的可访问属性 |
| 同步类型 | settle/project reason、同步结果、snapshot、conflict resolution 和 persisted conflict |
| 使用错误 | `ModuleRuntimeBusyError`、`ModuleRuntimeUnavailableError` |

必须遵守：

- 模块不能直接读写 IndexedDB、GitHub、token、revision、编辑锁或 Shared 内部组件；
- 模块不能修改 `runtime.current` 来推进状态，只能 dispatch event；
- 模块不能把系统状态混入 payload、event 或撤销队列；
- 模块不得自行读写 Shared 的 schemaVersion 或 migration 状态；当前版本和迁移规则仍由模块定义；
- 模块使用 SDK 提供的单标签锁、操作阻塞、云端遮罩和同步 UI，不实现竞态降级方案或第二套同步 UI；
- 纯图标按钮优先使用 Shared 图标 helper，并提供准确且相同的 `aria-label` 与 `title`；按钮样式和业务语义仍由模块负责；
- 失败提示不得包含 token、原始 GitHub 响应、请求头或任意序列化的捕获异常；

持久化模块的自动测试聚焦 domain 和 codec，包括 payload 校验、event 的 apply/invert、远端编码往返和非法输入。
