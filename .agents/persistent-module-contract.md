# 持久化模块公共契约

本文供所有需要保存业务数据的模块长期使用。它解释模块怎样划分状态、怎样调用 Shared SDK，以及 SDK 对模块承诺的可观察行为。

## 1. 五层模型与数据边界

| 层 | 内容 | 寿命 |
| --- | --- | --- |
| 用户命令 | 用户此刻要完成的动作 | 一次命令 |
| 实时状态 | 草稿、焦点、选择、拖拽、动画和页面呈现状态 | 当前标签页 |
| 数据暂存 | 当前完整业务 payload 和可逆业务 event | 当前标签页 |
| 本地数据 | 最近成功保存到当前设备的完整 payload | 跨刷新和浏览器重启 |
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

确实使用 JSON 兼容 payload 的模块使用 `defineJsonModule`。需要 `Map`、`Set`、`Date`、`ArrayBuffer`、类型化数组或其他可 structured-clone 数据的模块使用 `defineModule`，并自行提供稳定的 `contentKey`。函数、DOM 引用、`WeakMap` 等不能可靠持久化的值不得进入 payload。

### 模块定义

每个模块提供一份稳定的定义：

- 唯一且长期不变的 `moduleId`，格式为小写字母、数字和单连字符；
- `createEmpty()` 和 `validate(payload)`；
- 能完整反映业务语义的 `contentKey(payload)`；
- event 历史策略；
- payload 与远端受管文本文件之间的 `encode`/`decode`。

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

模块页面用 `startModuleRuntime({ definition, appRoot, hooks })` 启动。SDK 负责恢复统一登录、取得该模块的单标签编辑权、读取本地数据、在首次使用时读取云端或建立空数据、创建空历史、启动同步观察，并调用 `project(payload, "initialize")`。

启动结果只有四种：

| 状态 | 模块行为 |
| --- | --- |
| `ready` | 保存返回的 runtime，并进入可编辑页面 |
| `authentication-required` | 交给统一登录边界处理，不建立模块自己的登录 |
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

上传、拉取和两个覆盖方向由 SDK 显示同一份全页 spinner 与模糊遮罩。模块只负责触发命令和呈现业务合适的确认、状态及错误文字，不复制公共遮罩，也不直接访问 GitHub。

同步判断固定为：

| 云端变化 | 本地变化 | 结果 |
| --- | --- | --- |
| 否 | 否 | 保持一致 |
| 否 | 是 | 保留本地，等待用户上传 |
| 是 | 否 | 拉取云端到本地，并建立新页面会话 |
| 是 | 是 | 持久化冲突，不自动覆盖或合并 |

冲突可以跨刷新保留。模块只能让用户选择 `local-wins` 或 `cloud-wins`；不得自行自动合并或暗中选择方向。

`dirty === false` 只表示页面内容已经保存到本地，不表示已经上传。模块通过 `runtime.getSnapshot()` 或 `onSnapshotChange(snapshot)` 区分：

- `sessionDirty`：页面内容尚未保存到本地；
- `localChangedSinceSync`：本地版本尚未同步；
- `localSavedAt`：本地版本时间；
- `knownRemoteRevision` / `knownRemoteUpdatedAt`：最近已知云端版本；
- `pendingUpload`：存在尚未确认结果的上传；
- `conflict`：存在尚未解决的冲突。

状态观察回调只更新 UI；即使回调自身失败，也不能改变已经完成的 runtime 操作。

## 5. 公共接口与开发约束

业务模块只从 `src/shared` 根入口导入。准确 TypeScript 签名以该入口导出的源码类型为准；这里记录用途，不复制整套类型定义。

| 类别 | 公共能力 |
| --- | --- |
| 定义 | `defineModule`、`defineJsonModule`、`jsonContentKey`、`ModuleDefinition`、history policy/capacity |
| 启动 | `startModuleRuntime`、启动 options/result/state |
| runtime | `current`、历史状态、`dispatch`、`undo`、`redo`、`save`、`upload`、`pull`、`resolveConflict`、`pollNow`、`getSnapshot`、`dispose` |
| hooks | `settle`、`project`、`onConflict`、`onSnapshotChange` |
| 同步类型 | settle/project reason、同步结果、snapshot、conflict resolution 和 persisted conflict |
| 使用错误 | `ModuleRuntimeBusyError`、`ModuleRuntimeUnavailableError` |

必须遵守：

- 模块不能直接读写 IndexedDB、GitHub、token、revision、编辑锁或 Shared 内部组件；
- 模块不能修改 `runtime.current` 来推进状态，只能 dispatch event；
- 模块不能把系统状态混入 payload、event 或撤销队列；
- 模块使用 SDK 提供的单标签锁、操作阻塞和云端遮罩，不实现竞态降级方案或第二套公共 UI；
- 失败提示不得包含 token、原始 GitHub 响应、请求头或任意序列化的捕获异常；

持久化模块的自动测试聚焦 domain 和 codec，包括 payload 校验、event 的 apply/invert、远端编码往返和非法输入。
