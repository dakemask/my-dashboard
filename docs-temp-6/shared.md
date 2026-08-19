# Shared

## 概览

`src/shared` 是持久化业务模块共用的运行基础层。它把模块自己的数据模型和页面控制器接到浏览器本地存储、GitHub 数据仓库、跨标签页编辑锁、同步状态以及通用同步界面上。当前的碎片想法、思维导图和待办模块都通过同一套入口启动。

Shared 不定义任何模块的业务含义。模块提供 payload、业务事件、校验、远端文件编解码和迁移规则；Shared 负责保存这些数据、维护页面期历史、判断本地与云端的关系，并把结果暴露为统一运行时。首页是另一类调用方：它直接使用账户、profile 和同步内部能力，完成首次账户接入时的全模块数据检查与迁移。

业务模块使用的公开入口是 `src/shared/index.ts`，它只导出 `module` 门面。主要关系如下：

```text
模块 definition + controller hooks
                │
                ▼
       startModuleRuntime
                │
       DefaultModuleRuntime
                │
         SyncCoordinator
          ├─ SyncSessionState ─ StagingHistory
          │                   └ ModuleLocalStore
          └─ RemoteModuleRepository ─ GitHubGitDataClient
```

## 一、模块契约与运行时

一个持久化模块由 `ModuleDefinition<TPayload, TEvent>` 描述。这个定义聚合了五类信息：稳定的 `moduleId` 和空数据构造；payload 校验与语义内容键；事件的应用、反演和历史容量；payload 与一组远端文本文件之间的编解码；可选的逐版本迁移策略。`defineJsonModule` 只额外提供 JSON 数据的规范化内容键，其他行为与 `defineModule` 相同。

模块控制器通过 hooks 接入运行时：

- `settle` 在保存、同步、撤销或远端变化前结束仍停留在控件中的编辑，并可返回一个待派发事件。
- `project` 在初始化、撤销和重做后，用运行时 payload 重建模块界面。
- `onSnapshotChange` 接收同步快照，用于刷新模块自己的保存状态和通用同步界面。

`startModuleRuntime` 依次确定当前 profile 和本地/账户模式、取得模块编辑租约、建立本地存储与远端端口、初始化同步会话，再启动账户模式下的远端 revision 轮询。成功后返回初始 payload 和 `ModuleRuntime`。启动也可能得到 `blocked`、`unsupported` 或 `authentication-required`，这些结果发生在业务控制器取得可编辑运行时之前。

运行时本身有四个生命周期状态：

- `starting`：依赖、租约和初始数据仍在建立。
- `ready`：允许派发事件和执行保存、撤销、重做、上传、拉取等命令。
- `disposing`：停止轮询和认证订阅，等待已排队命令与持久化操作结束，并释放存储和编辑租约。
- `disposed`：资源已经释放，运行时不再接受命令。

同步命令在 `DefaultModuleRuntime` 中按调用顺序排队。同步的 `dispatch` 不进入该异步队列；当已有命令排队或持久化操作正在进行时，它会拒绝新的业务事件。`OperationGate` 在更底层串行化所有本地和云端持久化操作，并向 DOM 呈现层标明当前是 `local` 还是 `cloud` 操作。

## 二、payload、迁移与页面期事件历史

Shared 对 payload 使用语义内容键，而不是对象引用或普通序列化结果，来判断内容是否变化。当前代码生成的 payload 会经过校验、结构化克隆和内容键计算；从本地或远端读出的 payload 还会先执行 schema 迁移。版本化模块以显式源版本进入迁移流程，迁移函数每次前进一个版本，Shared 重复调用直至 `currentVersion`，随后再按当前模型校验。

`StagingHistory` 保存一份当前 payload 和一列可逆事件，不保存 payload 快照队列。每个历史项包含正向事件、反向事件以及事件前后的语义内容键；当前位置把同一列事件划分为已应用部分和可重做部分。真实变化会截断当前位置之后的重做分支，语义无变化的事件不会进入历史，也不会破坏已有重做分支。撤销和重做时，前后内容键同时用于验证模块提供的反演逻辑确实回到了预期状态。

历史还维护一个“已保存到本机”的内容基线。当前内容键与该基线不同即为 `dirty`。因此撤销历史、页面未保存状态和云端同步状态是三件独立的事：历史只存在于当前页面生命周期，保存会更新基线但保留事件队列，上传也不会清空撤销历史。

## 三、本地记录与同步会话状态

`ModuleLocalStore` 为每个 profile 与模块保存一个 IndexedDB 记录。整个记录以 `localRevision` 做 compare-and-swap 原子替换；页面持有的 revision 不是数据库当前 revision 时，写入会失败。编辑租约用于避免同一 profile 的同一模块被多个标签页同时编辑，CAS 则保证每次本地状态转换基于实际读到的上一版记录。

本地记录 `ModuleLocalEnvelope` 同时保存三组信息：

- 当前本地数据：`payload`、`schemaVersion`、`contentHash`、`localRevision` 和本地保存时间。
- 最近确认的同步基线：已同步内容哈希、远端 revision 和远端更新时间。
- 可跨刷新恢复的过程状态：`pendingUpload`、`conflict` 和 `migration`。

`SyncSessionState` 是这份记录在当前页面中的唯一状态所有者。它把本地 CAS、历史基线、迁移标记、待确认上传和冲突记录组合成 `SyncCoordinatorSnapshot`。其中几个容易混淆的状态含义如下：

- `sessionDirty`：页面当前 payload 尚未保存到 IndexedDB。
- `businessChangedSinceSync`：存在未保存业务变化，或已保存 payload 与最近同步内容不同。
- `migrationChangedSinceSync`：本地已经迁移到当前 schema，但该格式变化尚未在云端确认。
- `localChangedSinceSync`：前两类待同步变化的合并结果。
- `pendingUpload`：上传意图已写入本地，但远端结果尚未被确认。
- `conflict`：本地有变化时观察到了不同的远端 revision；其中保存的是已观察到的远端版本，而不是一份远端 payload。

初始化优先读取现有本地记录。记录存在时会完成迁移和完整性校验；本地模式会先建立空记录，账户 profile 没有记录时才从远端拉取，远端也不存在则使用模块的空 payload。初始化完成后，Shared 建立历史并通过 `project(..., "initialize")` 交给模块页面。

## 四、远端数据协议与同步决策

每个模块在数据仓库中占用 `data/<moduleId>/`。业务文件由模块 codec 决定；Shared 另外维护 `revision.json`，其中记录逻辑 revision、更新时间、schema 版本和本次受管文件清单。Git commit SHA 表示读取时的仓库快照，逻辑 revision 才是模块同步比较和幂等确认使用的版本标识。

`RemoteModuleRepository` 基于 GitHub Git Data API 读取仓库树并按清单加载模块文件。上传时，它先把业务文件与新 manifest 建成 blobs 和 tree，再创建非强制 commit 并移动分支引用。写入同时使用两层并发判断：模块逻辑 revision 用于判断业务冲突，Git 分支引用用于处理仓库中其他模块或其他写入造成的 head 竞争。

同步协调器的主要决策顺序是：

1. `save` 先调用 `settle`，把返回事件写入历史，再把当前 payload 原子保存到本地；它不访问云端。
2. `upload` 先结算并保存页面变化，再核对远端 revision。远端仍是最近同步版本时才执行普通推送；远端已经变化且本地也有变化时记录冲突；远端变化而本地没有变化时直接拉取。
3. `pull` 先核对远端 revision。本地没有变化时以远端完整替换本地记录并刷新页面；本地也有变化时记录冲突。
4. 轮询只读取 revision 元数据而不解码业务 payload。它确认自己的待定上传、更新已有冲突，或在无本地变化时触发拉取；持久化操作正忙时本轮观察返回 `busy`。
5. 冲突只有两个完整数据方向：`local-wins` 以本地 payload 覆盖当前云端版本，`cloud-wins` 以云端 payload 替换本地。Shared 不做字段级合并。

上传开始前会先持久化 `pendingUpload`，其中包含本次内容哈希、将要写入的远端 revision 和时间。即使网络响应丢失，后续上传或轮询仍可通过远端是否出现这个 revision 判断上次提交是否成功；这使上传重试不依赖页面内存。

迁移状态与业务变化分开记录。只有 schema 变化而没有业务编辑时，账户模式会尝试自动发布迁移；如果另一端已经发布了内容等价的当前 schema，Shared 会直接更新同步基线，而不制造冲突或重复提交。

## 五、账户、profile 与执行隔离

`profiles` 把运行环境分为本地模式和账户模式。没有账户记录时，活动上下文固定为本地 profile，远端端口不可用；存在账户时，活动账户提供 GitHub session 和独立 profile id。profile id 同时参与 IndexedDB 数据库名与 Web Lock 名，因此同一模块在本地模式和不同账户下拥有彼此隔离的本地数据与编辑租约。

当前首页通过 `authenticateGitHubCredentials` 验证 GitHub 身份、固定私有数据仓库、分支和读写权限，再由 profile store 保存账户并选择活动账户。首次从本地模式接入账户时，`src/home/firstAccountSetup.ts` 会用 Shared 的 definition、codec、store、repository 和 coordinator 对全部持久化模块做只读预检，然后按用户选择统一采用本地或云端方向建立账户 profile。普通模块启动不承担这个跨模块流程。

账户模式运行期间，远端 revision poller 持续检查版本。凭据被 GitHub 明确判定失效后，认证边界会使当前运行时进入释放流程，再回到首页账户入口。

`ModuleEditorLease` 的状态依次来自以下集合：`idle`、`acquiring`、`acquired`、`blocked`、`unsupported`、`released`。它使用非等待的独占 Web Lock；已有标签页持锁时得到 `blocked`，环境没有 Web Locks 时得到 `unsupported`。这两种结果都会由 Shared 渲染不可编辑页面，而不是启动一个降级编辑器。

## 六、通用同步界面与业务页面边界

`ModuleSyncUi` 是运行时快照到手动上传/拉取界面的公共适配层。它把命令执行、纯 view model 和 DOM 渲染分开；模块控制器只提供同步前的 `guardAction`，用于处理模块自身仍在进行的对话框、拖动、草稿或本地保存失败状态。

同步 view model 有七种展示状态：

- `loading`：运行时尚未完成初始化。
- `local`：本地模式，只展示本机保存信息。
- `conflict`：本地和远端都发生了变化。
- `pending`：存在尚待远端确认的上传。
- `unsaved`：页面有变化且本地保存失败。
- `local-ahead`：变化已保存到本机，但尚未同步到云端。
- `synced`：本地记录与已知云端版本一致。

上传和拉取遇到冲突时，通用界面负责确认完整覆盖方向；模块页面仍负责业务编辑、自动保存时机、撤销重做按钮和内容投影。`DomOperationGatePresentation` 在任一持久化操作期间把模块根节点设为不可交互，云端操作另外显示全页状态层。

## 代码定位

| 内容 | 主要实现 |
| --- | --- |
| 业务模块公开入口 | `src/shared/index.ts`、`src/shared/module/` |
| 模块契约、payload 准备与迁移 | `src/shared/module/definition.ts`、`src/shared/sync/modulePayload.ts` |
| 页面期可逆事件历史 | `src/shared/history/StagingHistory.ts` |
| 本地原子记录 | `src/shared/persistence/ModuleLocalStore.ts`、`src/shared/persistence/types.ts` |
| 同步状态与决策 | `src/shared/sync/SyncSessionState.ts`、`src/shared/sync/SyncCoordinator.ts` |
| GitHub 文件协议 | `src/shared/github/remoteModuleRepository.ts`、`src/shared/github/remoteModuleManifest.ts` |
| 运行时装配与生命周期 | `src/shared/module/startModuleRuntime.ts`、`src/shared/module/DefaultModuleRuntime.ts` |
| profile、认证与首次账户接入 | `src/shared/profiles/`、`src/shared/auth/`、`src/home/firstAccountSetup.ts` |
| 编辑租约和持久化串行化 | `src/shared/concurrency/` |
| 同步状态界面 | `src/shared/ui/ModuleSyncUi.ts`、`src/shared/ui/moduleSyncViewModel.ts` |
