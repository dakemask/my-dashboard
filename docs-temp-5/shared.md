# Shared 开发导览

本文件是 AI 处理 Shared 相关需求时的首读入口，记录需要跨文件才能确认的架构、状态和数据边界。具体 API 签名与局部实现按需求在所列入口中检索。

## 定位

`src/shared` 是各业务模块共用的浏览器端运行底座。它不定义待办、思维导图或碎片想法的业务规则，而是统一处理模块启动、事件历史、本地持久化、GitHub 同步、账户隔离、编辑并发和同步 UI。

业务模块的核心数据链路围绕两个对象：

- `ModuleDefinition` 描述模块的数据、事件、校验、历史、远端编码和迁移规则。
- `ModuleRuntime` 是控制器执行修改、撤销、保存、上传、拉取和冲突处理的入口。

`src/shared/index.ts` 是业务模块的公共入口，只导出模块开发需要的能力。`auth`、`profiles`、`persistence`、`sync`、`github` 等子目录主要供 Shared 自身和首页的平台流程使用。

主调用链如下：

```text
业务控制器
  -> ModuleRuntime
  -> SyncCoordinator（同步决策）
  -> SyncSessionState（会话状态迁移）
  -> StagingHistory + ModuleLocalStore
  -> RemoteModuleRepository -> GitHubGitDataClient
```

`startModuleRuntime` 负责组装整条调用链。它读取当前 profile，获取模块编辑租约，创建本地 store 和远端 repository，初始化协调器并投影初始 payload；账户模式还会启动远端 revision 轮询。启动结果可能是 `ready`、`blocked`、`unsupported` 或 `authentication-required`。

## 需求场景

### 新增业务模块或调整模块接入

模块接入点是 `defineModule` / `defineJsonModule`。一个定义集中提供以下语义：

- 稳定的 `moduleId` 和空数据构造；
- 对当前 payload 的完整校验；
- 表示业务语义内容的确定性 `contentKey`；
- 事件的 `apply`、`invert` 和页内历史容量；
- 远端受管文本文件的 `encode`、`decode`；
- 可选的业务 schema 迁移策略。

当前三个持久化模块都使用 `defineJsonModule`，由 Shared 为 JSON payload 生成规范化内容键。模块控制器持有 UI 草稿、选择状态等临时交互状态；Shared 持有已提交的 payload、历史和持久化状态。新增持久化模块还必须进入 `src/home/modules.ts` 的统一 catalog，因为首次添加账户时会以该 catalog 为完整的数据迁移范围。

控制器通过 hooks 与运行时配合：

- `settle` 在 Shared 即将读取 payload 前结束当前交互，可返回一个需要提交的业务事件；触发原因包括本地保存、上传、拉取、远端变化、撤销和重做。
- `project` 在初始化、撤销和重做后用运行时 payload 重建业务 UI。云端拉取成功后采用整页 reload，不走增量投影。
- `onSnapshotChange` 把持久化与同步状态交给页面；`onConflict` 只用于冲突通知。

### 修改业务数据、撤销重做或自动保存

业务修改以事件为唯一历史单位。`runtime.dispatch(event)` 同步应用事件并写入 `StagingHistory`；控制器随后按页面工作流调用 `runtime.save()`。Shared 不自动替业务控制器决定何时保存。

`StagingHistory` 保存当前 payload 以及成对的 forward/inverse 事件，不保存整份 payload 快照，也不包含同步元数据。它维护：

- 当前历史位置和 `canUndo` / `canRedo`；
- 当前语义内容键；
- 最近一次成功本地保存的基线键；
- 由当前键与基线键比较得到的 `dirty`。

无语义变化的事件不进入历史；新事件会替换当前位置之后的 redo 分支。撤销和重做会验证逆事件或正向事件确实回到记录的语义状态。保存成功只更新本地基线，不清空页内事件历史。

运行时生命周期状态为 `starting -> ready -> disposing -> disposed`。异步命令通过运行时队列串行执行；持久化队列或异步命令存在时，新的同步 `dispatch` 会以 busy 失败，避免 UI 修改穿插进一次保存或同步。

### 理解本地数据和同步状态

整体工作流是 local-first：`dispatch` 只改变页内 payload 和历史，`save` 写入 IndexedDB，`upload` 才发布到 GitHub；本地模式完全不建立云端数据链路。账户模式首次没有本地记录时会从云端初始化，云端也为空时才使用模块空数据。

每个 profile、每个 module 在 IndexedDB 中有独立数据库，数据库内只有一条完整替换的 `ModuleLocalEnvelope`。信封中的字段分为四组：

- 业务内容：`payload`、`schemaVersion`、`contentHash`；
- 本地写入版本：`localRevision`、`localSavedAt`；
- 最近同步基线：`lastSyncedContentHash`、`lastSyncedRemoteRevision`、`lastSyncedRemoteUpdatedAt`；
- 可恢复流程：`pendingUpload`、`conflict`、`migration`。

本地写入使用 `localRevision` 做 compare-and-swap，并在每次成功替换后生成新值。它与云端 `revision`、Git commit SHA 是三个不同概念：前者保护 IndexedDB 记录，云端 revision 表示模块业务版本，commit SHA 表示仓库分支快照。

同步状态不是单一枚举，而是由信封和页内历史推导：

- `sessionDirty`：当前页内 payload 尚未保存到 IndexedDB；
- `businessChangedSinceSync`：页内或已保存业务内容不同于最近同步基线；
- `migrationChangedSinceSync`：本地完成了尚未在云端确认的 schema 迁移；
- `localChangedSinceSync`：前两类变化中任意一类存在；
- `pendingUpload`：上传意图已先持久化，结果尚待确认；
- `conflict`：已观察到与本地同步基线不一致的远端版本。

`SyncCoordinator` 负责远端 I/O 和上传、拉取、冲突选择等决策；`SyncSessionState` 集中维护信封、历史、CAS 写入和上述派生状态。修改同步行为时应先判断问题属于“决策”还是“状态迁移”，不要在两处重复维护状态。

### 修改上传、拉取、冲突或远端轮询

上传会先结算当前交互并保存 dirty payload，再读取云端 revision、核对未确认上传并比较最近同步基线。远端未变且本地内容领先时才执行 push；远端已变且本地也有变化时记录冲突；远端已变但本地无变化时直接拉取。

拉取在远端版本变化后先结算交互。本地有变化时只记录冲突，不覆盖内容；本地无变化时用远端 payload 原子替换信封，然后 reload 页面。

冲突只提供两个明确方向：

- `local-wins`：以操作时读取到的当前云端 revision 为基线覆盖上传；
- `cloud-wins`：拉取云端内容并替换本地信封。

Shared 没有字段级自动合并层。冲突和未确认上传都持久化在本地信封中，因此刷新页面不会丢失。上传前会先写入带 `nextRemoteRevision` 的 `pendingUpload`；即使网络响应丢失，后续读取发现该 revision 已在云端，也能把上传确认为成功。

账户模式通过可见性敏感的 revision poller 观察远端变化，回到在线状态时会立即重新检查。轮询只读取 manifest revision；真正需要内容时才 pull。同步命令结果为 `unchanged`、`saved`、`uploaded`、`conflict`、`reloaded` 或 `busy`，它们是一次命令的结果，不是长期状态机。

### 修改 GitHub 远端格式或提交方式

远端仓库固定为当前 GitHub 用户名下的私有 `my-dashboard-data` 仓库，分支为 `main`。每个模块位于 `data/<moduleId>/`：

```text
data/<moduleId>/revision.json
data/<moduleId>/<模块 encode 产生的受管文本文件>
```

`revision.json` 是模块远端版本的权威入口，记录 `revision`、`updatedAt`、可选 `schemaVersion` 和有序的 `managedFiles`。读取先取得同一 branch head 的递归 tree，再从该快照读取 manifest 与受管 blobs，避免混用不同提交的数据。

写入使用 Git Data API 创建 blobs、tree、commit，再非强制更新 branch ref。普通 push 以 manifest revision 做乐观并发检查；branch ref 在提交期间变化时会重新读取并有限重试。相同的 `nextRevision` 已存在时按幂等成功处理。新编码不再声明的旧受管文件会被删除，模块目录中的未知文件会保留。

### 修改 schema 版本或数据迁移

采用迁移策略的模块必须在本地信封和远端 manifest 中携带明确的 `schemaVersion`。Shared 不猜测无版本数据属于版本 1。当前三个模块的 `currentVersion` 都是 1，尚无实际的旧版本迁移链。

`migrate(value, fromVersion)` 每次只前进一个版本；运行时重复调用直到 `currentVersion`，之后再执行当前版本校验和内容哈希。远端 codec 在存在迁移策略时先把旧结构解码为 `unknown`，由运行时完成迁移后再暴露为当前 payload。

本地旧数据会先以 CAS 方式持久化迁移结果，再成为活动会话。`migration` 元数据把“只发生格式升级”和“同时存在业务修改”区分开：纯迁移在远端基线未变时可自动发布；若另一端已经发布了语义等价的当前版本，Shared 会确认该版本而不制造冲突。高于当前代码支持的 schema 会直接阻止加载。

### 修改账户、本地模式或首次添加账户

当前账户入口使用 `DashboardProfileStore`。profile 元数据和 GitHub 凭据保存在 localStorage，业务 payload 保存在 IndexedDB。没有账户时，活动上下文是 `local` profile，数据只在本浏览器；有账户后，活动上下文包含 profile id、GitHub 会话和账户专属的 IndexedDB/编辑锁。切换账户通过切换活动 profile 实现，各账户的本地模块数据互不共用。

GitHub 凭据验证会确认用户名、固定仓库归属、私有属性、`main` 分支以及 pull/push 权限。运行中的 GitHub 请求收到明确的 401 后，Shared 会使当前凭据失效、释放运行时资源并回到首页账户边界。

首次从本地模式添加账户由 `src/home/firstAccountSetup.ts` 编排。它使用 Shared 的底层端口对 catalog 中全部持久化模块先做只读预检；本机与云端同时有数据时由用户统一选择 `local-wins` 或 `cloud-wins`。确认后才逐模块建立账户 profile 数据，全部完成后注册账户并清理 `local` profile。远端提交无法跨模块回滚，因此本地覆盖云端失败后的恢复策略是保持同一方向重试。

`createAuthService`、`credentialsStore` 和 `loginGate` 属于仍保留的旧单账户接入路径；当前首页账户流程直接使用凭据验证函数和 profile store。除非需求明确涉及该兼容入口，不应以它作为现行账户架构的起点。

### 修改多标签并发、操作阻塞或同步 UI

`ModuleEditorLease` 通过 Web Locks 为 `profileId + moduleId` 持有整个编辑页生命周期的非等待独占锁。状态为：

```text
idle -> acquiring -> acquired -> released
                   -> blocked
idle ----------------> unsupported
```

另一个标签页已持锁时启动结果为 `blocked`；浏览器没有 Web Locks 时为 `unsupported`。两种情况都会显示不可编辑页，不会降级为无锁写入。

`OperationGate` 把 local/cloud 持久化操作放入同一串行队列，并只展示当前正在执行的操作。默认模块运行时的 DOM presentation 会在两类操作期间暂时令模块根节点不可交互，cloud 操作额外显示全局遮罩。运行时的命令队列负责更外层的命令顺序，二者职责不同。

`ModuleSyncUi` 是业务模块使用的同步 UI 门面。控制器提供 `guardAction` 处理业务草稿、拖动等交互门禁，传入 runtime 并持续投递 snapshot；Shared 负责上传/拉取确认、消息和纯视图投影。视图状态按优先级派生为：

```text
loading | local | conflict | pending | unsaved | local-ahead | synced
```

其中 `unsaved` 还依赖控制器报告的本地保存失败；该失败是页面交互状态，不写入运行时 snapshot。

## 修改约束

- 业务模块优先只从 `src/shared/index.ts` 导入；直接使用 Shared 子层只适用于首页或平台级流程。
- payload 修改必须经过可逆业务事件和 `runtime.dispatch`，持久化必须经过 runtime 命令；控制器不直接写 IndexedDB 或 GitHub。
- `validate`、`contentKey`、事件 apply/invert、codec 和迁移必须确定且不依赖 UI 临时状态。`contentKey` 必须覆盖全部业务语义，否则 dirty、历史校验和同步判断都会失真。
- 不合并 `localRevision`、远端 `revision` 和 Git commit SHA，也不另建重复的 dirty、pending 或 conflict 状态源。
- 新增持久化模块时同时更新统一 module catalog，并保持首次账户预检覆盖全部模块。
- schema 升级必须保留逐版本迁移链并显式提升 `currentVersion`；不要为缺失版本自动指定默认值。
- 冲突处理保持显式的本地胜出或云端胜出。若产品确实需要自动合并，应先重新定义共享同步协议，而不是在 UI 层绕过协调器。

## 最小读码路线

收到 Shared 相关需求后，按问题只读对应入口：

- 模块接入与生命周期：`src/shared/module/`；
- 编辑历史：`src/shared/history/StagingHistory.ts`；
- 同步决策与状态：`src/shared/sync/SyncCoordinator.ts`、`SyncSessionState.ts`、`types.ts`；
- 本地信封与 CAS：`src/shared/persistence/`；
- 远端格式与 GitHub 提交：`src/shared/github/remoteModuleRepository.ts`、`remoteModuleManifest.ts`；
- 账户隔离：`src/shared/profiles/`，首次账户接入另看 `src/home/firstAccountSetup.ts`；
- 同步交互：`src/shared/ui/ModuleSyncUi.ts`、`moduleSyncActions.ts`、`moduleSyncViewModel.ts`。
