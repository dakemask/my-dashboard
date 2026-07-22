# Shared 与平台维护规范

## 1. 读者和边界

本文只供已经获得用户允许、需要修改 Shared、首页认证、持久化或同步基础设施的 agent 阅读。普通业务模块开发不得顺手修改这些边界，也不得复制本文中的内部算法；其阅读路径由仓库根目录 [AGENTS.md](../AGENTS.md) 指定。

本文记录当前平台的固定实现、内部数据结构、安全不变量和 Shared 验收要求。这里的类和字段可以由 Shared 维护任务演进，但 `src/shared/index.ts` 暴露的模块 SDK 契约必须保持稳定或显式升级。

平台公共能力不提供业务 `schemaVersion`、旧格式迁移、自动冲突合并、退出登录或真实 GitHub 数据迁移；改变这些边界必须作为单独的用户决策处理。公共接口要求见 [持久化模块公共契约](./persistent-module-contract.md)，首次接入示例见 [新持久化模块接入指南](./new-persistent-module-guide.md)。

## 2. 代码边界和公共入口

```text
src/shared/index.ts          业务模块唯一入口
src/shared/module/           模块 SDK 门面与定义辅助函数
src/shared/auth/             首页认证与凭据状态
src/shared/history/          当前 payload 与页面内可逆 event 历史
src/shared/persistence/      每模块 IndexedDB
src/shared/concurrency/      操作队列与 Web Locks
src/shared/github/           Git Data API 与原子模块仓库
src/shared/sync/             同步协调器与轮询器
src/shared/ui/               公共遮罩、spinner 和阻止页面
```

业务模块只获得 `ModuleRuntime<TPayload, TEvent>`，不得获得或长期持有 token、client、repository、store、coordinator、gate 或 lease。

`startModuleRuntime(options)` 是业务入口。第二个 `ModuleRuntimeEnvironment` 参数只用于平台组合与测试注入，因此不从 Shared 根入口导出；内部维护代码需要时从 `shared/module/runtime` 读取，业务模块必须省略。

## 3. 固定平台约定

| 项目 | 固定值或规则 |
| --- | --- |
| GitHub 仓库 | 当前登录用户拥有的私有仓库 `my-dashboard-data` |
| Git 分支 | `main` |
| 模块根目录 | `data/<moduleId>/` |
| 模块清单 | `data/<moduleId>/revision.json` |
| 本地数据库 | `my-dashboard.module.<moduleId>` |
| 编辑锁 | `my-dashboard.module.<moduleId>.editor` |
| 历史容量 | 由模块定义为正整数或 `"unlimited"`，按 event 数量计 |
| 暂存历史 | 一个当前完整 payload 加 forward/inverse event 对，仅当前页面存活 |
| 持久化内容 | IndexedDB 和 GitHub 均保存完整 payload，不保存 event 队列 |
| 远端受管内容 | UTF-8 文本文件 |
| 边界复制 | 原生 `structuredClone` |

`moduleId` 必须匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`。目标浏览器必须支持 ES2022、IndexedDB、Web Crypto、Web Locks、`structuredClone` 和 `inert`。

## 4. 统一认证和首页安全

### 4.1 首次登录

用户只输入 GitHub 用户名和 token。以下检查全部成功后才写入 `localStorage`：

1. `GET /user` 验证 token 身份；
2. 返回的 `login` 与输入用户名按 GitHub 大小写规则一致；
3. `GET /repos/<username>/my-dashboard-data`；
4. 仓库 owner 与用户一致且 `private === true`；
5. 权限同时包含 pull/read 和 push/write；
6. `refs/heads/main` 存在且可读。

验证不得创建测试文件或 commit。凭据长期保留，产品不提供退出按钮。

### 4.2 凭据失效

`GitHubGitDataClient` 构造时必须传入 `AuthService.invalidate`。只有明确的 HTTP `401` 调用该回调；`403`、限流、离线和服务异常不得误清凭据。

模块 runtime 订阅认证状态。状态变为 anonymous 时必须：

1. 停止轮询；
2. 等待当前命令和 OperationGate；
3. 移除 Shared 的认证与页面生命周期监听；
4. 关闭本地 store；
5. 释放 lease；
6. 清空对 coordinator/client/token 的可达引用；
7. 返回首页登录边界。

Shared 不拥有业务模块注册的键盘或 UI 监听，因此不负责清理它们；模块卸载流程必须自行移除。

### 4.3 token 不变量

token 只能存在于认证存储和发往 `https://api.github.com` 的 `Authorization` 请求头。它不得进入 DOM、URL、异常消息、日志、业务 payload、业务 event、IndexedDB 模块记录、Git commit、测试快照或模拟错误文本。

展示错误不得直接使用 GitHub 响应体、请求头或任意序列化的捕获异常。

### 4.4 CSP

首页 CSP 最低等价于：

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
connect-src 'self' https://api.github.com;
object-src 'none';
base-uri 'none';
form-action 'self'
```

不得加入 `unsafe-eval`，不得允许其他 token 发送目标。

## 5. ModuleRuntime 自动装配

### 5.1 启动顺序

`startModuleRuntime` 固定执行：

1. 创建或注入 `AuthService`，恢复认证会话；
2. 无凭据时返回 `authentication-required`；
3. 非等待地获取模块 Web Lock；
4. blocked/unsupported 时只渲染公共阻止页面；
5. 创建公共 DOM presentation 与 `OperationGate`；
6. 创建 `ModuleLocalStore`；
7. 使用认证会话创建 GitHub client 和 `RemoteModuleRepository`；
8. 创建并初始化 `SyncCoordinator<TPayload, TEvent>`；
9. 创建 revision poller；
10. 注册 auth anonymous 和 `pagehide` 清理；
11. 启动轮询并返回不暴露内部对象的 runtime 门面。

Shared 在任何步骤都不得注册 `keydown` 或其他业务命令快捷键。键盘属于模块 UI 层，不在 runtime 自动装配范围内。

每获得一个资源都必须立即登记逆序清理函数。启动任一步失败都要继续尝试全部清理，且不得用清理错误覆盖原始启动错误。

### 5.2 runtime 命令和销毁

`dispatch(event)` 是同步页面内命令：runtime ready、没有排队命令且 OperationGate 空闲时，交给 coordinator 原子应用并记录 event；busy 时抛出 `ModuleRuntimeBusyError`。它不进入持久化命令尾队列。

runtime 的 undo、redo、save、upload、pull、冲突解决和轮询产生的状态写入经过同一命令尾队列。undo/redo 必须先异步调用 `settle`，不能绕过 coordinator 直接操作 `StagingHistory`。

`dispose()` 是幂等、one-shot 的：先把状态设为 disposing，再停止新命令、停止并等待 poller、等待命令尾和 gate、关闭 coordinator/store、释放 lease，最后清空内部引用并进入 disposed。

runtime 在进入 ready 后先调用一次可选的 `onSnapshotChange`；同步 `dispatch` 完成后以及命令尾中的 undo、redo、save、upload、pull、冲突解决和轮询观察处理结束后再次提供 coordinator 最新 snapshot。通知发生在业务/持久化状态已经完成推进或失败保持原状之后，不能成为事务的一部分。runtime 必须捕获观察者异常，使其不能回滚、覆盖或改写原命令结果；disposing/disposed 后不得继续通知。snapshot 中的 `pendingUpload` 和 `conflict` 必须 clone。

401 回调可能发生在当前 gate 命令内部，因此只能异步触发 dispose，不能在 GitHub 请求栈中同步等待自身命令。

正常页面关闭由 `pagehide` 自动调用 dispose。单页应用卸载模块时，宿主先移除业务模块自己的监听，再显式调用 dispose。

### 5.3 平台与测试注入

`ModuleRuntimeEnvironment` 可以注入 `AuthService`、fetch、IndexedDB factory、LockManager、Document、Window、随机数、时钟、UUID、reload 和认证返回回调。生产业务模块不得传入这些依赖；它们只用于平台宿主和确定性的 Shared 测试。

`autoStartPolling: false` 只用于测试启动和资源清理，不是业务模块关闭同步的开关。

## 6. ModuleDefinition 与 clone 边界

`ModuleDefinition<TPayload, TEvent>` 同时定义完整 payload codec 和页面内 event 历史策略：

```ts
interface ModuleDefinition<TPayload, TEvent> {
  readonly moduleId: string;
  createEmpty(): TPayload;
  validate(value: unknown): TPayload;
  contentKey(payload: TPayload): string;
  encode(payload: TPayload): ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;
  decode(files: ReadonlyMap<string, string>): TPayload | Promise<TPayload>;
  readonly history: {
    readonly capacity: number | "unlimited";
    apply(payload: TPayload, event: TEvent): TPayload;
    invert(event: TEvent, before: TPayload, after: TPayload): TEvent;
  };
}
```

`capacity` 的 number 在 runtime 建立历史时验证为正整数；没有隐式默认容量。`defineModule`/`defineJsonModule` 冻结 definition 和 history 外壳，但纯函数和不修改参数仍是模块契约。

所有进入 Shared 的 payload 先 validate，再 structured clone，并对 clone 后形态复验。所有传给模块 codec、history 回调、hooks 和公共 getter 的 payload 都是 clone，不能暴露内部 current 引用。

业务 event 也必须能 `structuredClone`。dispatch 保存的 forward event、`invert` 返回的 inverse event 以及应用时传给模块的 event 都相互隔离。event 没有通用运行时 schema；它的合法性、可逆性和纯函数行为由模块定义及模块测试保证。

`RemoteModuleRepository.pull()` 在 decode 后独立调用 validate；`SyncCoordinator` 在写入本地前再次验证和计算 hash。两层校验不能因当前调用路径看似重复而删除。

content hash 是 `SHA-256(UTF-8(contentKey))`。业务 payload 和 event 都不包含保存或同步元数据，也不包含业务 `schemaVersion`。

## 7. StagingHistory 内部规则

`StagingHistory<TPayload, TEvent>` 长期保存：

- 一个当前完整 payload 及其 content key；
- 一个保存基线 content key；
- 若干 `{ forward, inverse, beforeKey, afterKey }` event 条目；
- 当前撤销/重做位置。

它不长期保存每一步完整 payload。before/after payload 只作为一次 dispatch、undo 或 redo 计算中的临时 clone。

### 7.1 dispatch 原子流程

`dispatch(event)` 固定执行：

1. clone 当前 payload 为 `before`，clone 输入 event 为 `forward`；
2. 用隔离参数调用 `apply(before, forward)`，clone 返回值，并通过 coordinator 的 validate/contentKey 边界；
3. 如果 after key 等于 current key，判定为 no-op，返回 current clone；不调用 `invert`，不记录 event，也不剪 redo；
4. 用隔离的 forward/before/after 调用 `invert`，并 clone inverse；
5. 在临时数组中剪掉当前位置后的 redo，追加 forward/inverse/key 条目；
6. 若容量为正整数，按 event 条目数淘汰最旧超额项并调整位置；`"unlimited"` 不淘汰；
7. 最后一次性替换 entries、position、current 和 current key。

apply、validate、contentKey、invert 或任一 structured clone 抛错时，第 7 步不得发生，因此 current、event 队列、position、redo 和保存基线全部保持原样。一个失败的真实 event 也不得提前删除 redo 分支。

### 7.2 undo 与 redo

- undo 先确认 current key 等于条目的 `afterKey`，再用 inverse event 计算 next；只有 next key 等于 `beforeKey` 才推进 current 和 position。
- redo 先确认 current key 等于条目的 `beforeKey`，再用 forward event 计算 next；只有 next key 等于 `afterKey` 才推进 current 和 position。
- apply、validate、clone、contentKey 或 key 校验失败时，undo/redo 同样保持完全原子。
- `current`、dispatch/undo/redo 返回值都是 clone。
- 本地保存只更新保存基线 key，不创建、删除或截断 event 条目。

`history.apply` 和 `history.invert` 必须是确定、无副作用的纯函数。Shared 会给它们 clone，但不能允许它们依赖 DOM、网络、时钟、随机数、存储或可变全局状态；否则 redo 和跨调用验证将不可靠。

## 8. settle、投影与会话寿命

`settle(reason)` 返回 `TEvent | null | Promise<TEvent | null>`，reason 固定为：

```text
local-save | upload | pull | remote-change | undo | redo
```

coordinator 在继续原操作前用正常 dispatch 路径处理非 null event。因此 settle event 与直接业务 event 具有相同的 clone、验证、no-op、分支和错误原子性；settle/dispatch 失败时原命令失败，不能在部分推进后继续保存或同步。

触发时机：

- save 和 upload 在读取当前 payload 前结算；
- 主动 pull 只有确认远端 revision 变化后才用 `pull` 结算；
- 轮询观察到不同 revision 后用 `remote-change` 结算，再判断本地变化或自动拉取；
- undo/redo 先结算，再执行相应 event。

`project(payload, reason)` 只用于 `initialize | undo | redo`。云端拉取会把完整 payload 原子写入 IndexedDB、建立新的空 event 会话并 reload，而不是把旧 event 队列迁移到云端 payload 上。

event 队列从不写入 IndexedDB、GitHub、localStorage 或同步元数据。页面刷新后由 IndexedDB 完整 payload 新建一个 position 为 0 的历史。

## 9. IndexedDB 内部记录

每模块一个数据库、一个完整记录：

```ts
interface ModuleLocalEnvelope<TPayload> {
  payload: TPayload;
  contentHash: string;
  localRevision: string;
  localSavedAt: string | null;
  lastSyncedContentHash: string | null;
  lastSyncedRemoteRevision: string | null;
  lastSyncedRemoteUpdatedAt: string | null;
  pendingUpload: {
    localRevision: string;
    contentHash: string;
    nextRemoteRevision: string;
    updatedAt: string;
  } | null;
  conflict: {
    observedRemoteRevision: string | null;
    observedRemoteUpdatedAt: string | null;
    detectedAt: string;
  } | null;
}
```

`localRevision` 是每次成功替换完整记录时生成的新 UUID。所有写入使用单个 read-write 事务和整条记录 compare-and-swap。写入前先 structured clone；事务、clone 或校验失败时不得推进 payload、revision 或任何 baseline。

CAS 的输入和返回值都必须 clone，公共 snapshot 中的 pending/conflict 也必须 clone，防止 readonly 类型之外的运行时别名修改。

event 历史不跨刷新保存；pending upload 和 conflict 必须跨刷新保存。

数据库版本仍固定为 1，不为显示时间升级 schema。旧记录在读取边界把缺少的 `localSavedAt`、`lastSyncedRemoteUpdatedAt` 和 `conflict.observedRemoteUpdatedAt` 规范化为 `null`；随后任一次整记录 CAS 会自然写入新形态。`localSavedAt` 只描述当前完整 payload 最近一次成功落盘的时间，不是每次元数据 CAS 的时间：创建初始记录、用户保存、云端拉取和首次持久化某个新冲突会推进它；pending 写入、上传确认和仅补齐远端时间不会推进它。

## 10. OperationGate、公共 UI 和编辑锁

同一 runtime 的持久化操作由 `OperationGate` 串行执行：

- local：`appRoot.inert = true`，不显示遮罩；
- cloud：root inert、模糊，并在 body 添加公共全页 spinner/overlay；
- 成功、失败或 presentation 初始化中途抛错都在 finally 清理。

严格 CSP 页面必须在 HTML 中外链唯一的 `operationGate.css`。不得从 TypeScript 动态导入该文件：开发服务器会把它转换为 CSP 拒绝的内联样式。`DomOperationGatePresentation` 只负责创建 DOM、切换公共 class 和清理；所有模块引用同一份 Shared 样式，但每个 runtime 创建独立实例，不使用跨模块全局 spinner 单例。

编辑锁使用 `navigator.locks.request(name, { mode: "exclusive", ifAvailable: true })` 并让 callback 在整个会话期间 pending。第二标签只显示公共 blocker。不支持 Web Locks 时禁止编辑；不得使用 localStorage、BroadcastChannel 或心跳降级锁。

## 11. GitHub 远端格式

### 11.1 revision.json

每个已初始化模块根包含：

```json
{
  "revision": "唯一 revision 标识",
  "updatedAt": "ISO 8601 UTC 时间",
  "managedFiles": ["按字典序排列的相对路径"]
}
```

`managedFiles` 只列业务 codec 管理的 UTF-8 文本文件，不包含 `revision.json`。路径必须规范、无重复、无大小写或父子碰撞，且不能越出模块根。

未知文件永远保留。只有旧清单包含、而新清单不再包含的受管路径可以删除。缺少清单表示模块未初始化，不授权接管目录内未知文件。损坏清单、缺失受管文件或解码失败必须停止。

### 11.2 单次原子上传

上传只用 Git Data API：

1. 读取 `main` 当前 ref、commit 和根 tree；
2. 在访问 GitHub 前把 next revision、content hash 和时间写入 `pendingUpload`；
3. 为全部新受管文本和新 `revision.json` 创建 blob；
4. 以当前根 tree 为 base tree，写入新文件和清单，并仅删除旧受管差集；
5. 创建一个以当前头为唯一 parent 的 commit；
6. 以 `force: false` 更新 `refs/heads/main`；
7. 确认 revision 后，在一个本地事务中更新同步 baseline 并清空 pending。

一次模块上传只有一个可见 commit。不得逐文件使用 Contents API，不得 force push。上传输入来自 IndexedDB 中已经保存的完整 payload，与页面 event 队列无关。

`main` ref 是会变化的资源，其 GET 必须使用 `cache: "no-store"` 绕过浏览器 HTTP 缓存。否则上传前缓存的旧 ref 可能在 PATCH 成功后继续被主动拉取或轮询读到，并被误判为新的云端变化。按 SHA 寻址的 commit、tree 和 blob 是不可变资源，不需要禁用缓存。

### 11.3 ref 竞态和幂等

非强制 ref 更新失败后重新读取新头：

- 模块 revision 已等于 pending revision：响应丢失，幂等确认成功；
- 模块 revision 仍是期望值：其他模块推进了 main，以新头重建，最多重试三次；
- 模块 revision 变成其他值：同模块冲突，不自动覆盖。

网络结果不确定时保留 pending revision。`local-wins` 也只能基于最新头创建一个新 commit，不能 force 更新。

`pendingUpload.updatedAt` 同时写入新 `revision.json`。上传确认使用仓库实际返回/轮询观察到的 `updatedAt`；响应丢失而只确认到相同 pending revision 时，如果远端没有提供时间，才回退到 pending 时间。确认事务一起推进 `lastSyncedRemoteRevision` 与 `lastSyncedRemoteUpdatedAt`。同 revision 的后续完整观察可只用一次本地 CAS 补齐旧记录中缺少的远端时间。

## 12. SyncCoordinator 状态机

状态判断使用：

- `cloudChanged`：远端 revision 与 `lastSyncedRemoteRevision` 不同；
- `localChanged`：暂存 current 或本地完整 payload 的 hash 与 `lastSyncedContentHash` 不同。

| cloudChanged | localChanged | 内部行为 |
| --- | --- | --- |
| 否 | 否 | unchanged |
| 否 | 是 | 保留本地，等待上传 |
| 是 | 否 | cloud gate 拉取、原子替换 IndexedDB、reload |
| 是 | 是 | CAS 持久化 conflict |

公共 `SyncCoordinatorSnapshot` 的时间/版本投影固定为：

- `localSavedAt` 直接来自本地 envelope；
- 没有冲突时，`knownRemoteRevision` / `knownRemoteUpdatedAt` 来自最近同步的 revision / updatedAt；
- 有冲突时，两者改为 conflict 观察到的 revision / updatedAt；
- `lastSyncedRemoteRevision` 始终保留真正同步基线，不能被冲突观察推进；
- 尚未见过时间或读取旧记录时返回 `null`，不得用客户端当前时间伪造云端时间。

普通 pull 必须先 reconciliation pending upload，再比较远端 baseline；“云端未变、本地已变”不得制造假冲突。

冲突存在时允许继续本地 dispatch/save，但 upload 或主动 pull 前必须显式 resolve：

- local-wins：结算并保存当前完整 payload，再 overwrite 当前模块；
- cloud-wins：拉取最新完整模块，清空 pending/conflict，写入本地并 reload。

`#recordConflict(remoteVersion)` 不能只写 conflict 标记。它必须读取 `history.current` 并计算 content hash，在**同一次 IndexedDB compare-and-swap** 中写入当前完整 payload、content hash、新 local revision、`localSavedAt` 和含 revision/updatedAt 的 conflict；只有 CAS 成功后才能调用 `history.updateBaseline(payload)` 和 `onConflict`。这保证由 `pull`/`remote-change` settle event 产生的本地一侧跨刷新仍存在。该写入不得推进 `lastSyncedContentHash`、`lastSyncedRemoteRevision` 或 `lastSyncedRemoteUpdatedAt`：history dirty 可因成为本地已保存基线而变为 false，但 local-changed-since-sync 仍必须为 true。同一冲突 revision 后来取得非 null `updatedAt` 时，只补齐 conflict 时间并保留原 `detectedAt`。

所有传给远端 port 的 payload 都必须 clone；所有传给模块 hooks 的 payload/conflict 也必须隔离。业务 event 不进入远端 port。

## 13. 轮询

poller 使用上一次完成后再安排下一次的一次性 timer：

- 前台：60 秒 + 0–15 秒随机量；
- 后台：5 分钟 + 0–60 秒随机量；
- visibilitychange 双向重排；
- online 立即安排一次。

普通网络失败静默等待下一轮。GitHub client 的 401 回调负责认证失效。

poller 的一次观察必须完整传递 `RemoteRevisionSnapshot | null`，不能为了去重只传 revision 字符串；coordinator 同时需要 `revision` 与 `updatedAt` 来推进已知云端时间、补齐旧基线以及持久化冲突时间。同 revision 但时间从未知变为已知也属于有意义的观察。

`stop()` 必须 abort 当前 signal、等待 in-flight 结束，并在停止后禁止调用 `onRevision` 或认证回调。`RemoteModuleRepository.readRevision(signal)` 和 GitHub branch/blob 读取必须贯通 AbortSignal，避免 runtime dispose 后继续写已关闭 store。

## 14. 失败不变量

任何失败路径都必须满足：

1. token 不进入输出、日志、业务 payload/event 或持久化记录；
2. history 的 apply、invert、clone、校验或 contentKey 失败不改变 current、event 队列、position、redo、dirty 或 baseline；
3. 未提交的 IndexedDB 事务不推进任何本地或同步 baseline；冲突 CAS 失败也不得只留下 conflict 标记或提前更新 history baseline；
4. 未确认 GitHub commit 不推进同步 baseline；
5. 保存失败不清空 event 历史或 dirty；
6. 上传、拉取和覆盖失败不自动选择冲突方向；
7. inert、spinner 和 overlay 必须恢复；
8. 未知文件不删除，main 不 force-update；
9. 损坏 payload 在 validate 边界停止，不尝试旧格式迁移；
10. runtime 启动失败逆序释放已经获得的每一个资源；
11. dispose 后不得有 poller、Shared listener、lease、store 或 token 可达链继续存活。

## 15. Shared 验收

### 15.1 模块 SDK

- 业务模块只从 Shared 根入口导入。
- 一次启动自动装配 auth、lease、gate、store、repository、coordinator 和 poller。
- Shared 不注册键盘快捷键；集成测试确认没有自动 `keydown` 监听，业务调用 `undo/redo/save` 仍工作。
- ready、authentication-required、blocked、unsupported 都有集成测试。
- 初始化失败会释放锁并允许重试。
- 401 会清凭据、等待命令结束、dispose 并返回登录边界。
- `dispatch(event)` 受 ready/busy 边界保护；异步 undo/redo 经 settle 串行执行。
- `onSnapshotChange` 在 ready、dispatch、历史/持久化命令和轮询处理后收到隔离快照；观察者抛错不改变命令结果，dispose 后不再通知。
- 公共 spinner/overlay 由 runtime 自动使用。

### 15.2 event 历史和持久化

- 不同正整数容量、`"unlimited"`、分支、no-op 保留 redo、保存后撤销、回到 baseline clean 和刷新清空正确。
- apply/invert 的 forward → inverse 可逆性以及 undo/redo key 校验有测试。
- apply、invert、structuredClone、validate、contentKey 抛错均不推进任何历史状态。
- JSON 和非 JSON structured-clone payload/event 都有测试。
- 调用者、contentKey、codec、history 回调、hook 和 snapshot 都不能修改内部引用。
- event 队列不进入 IndexedDB/GitHub；每模块数据库隔离，CAS 原子，失败不推进，pending/conflict 跨刷新；数据库 v1 旧记录的三个时间字段读取为 `null`。
- 远端冲突会把 settle 后的当前完整 payload、hash 和 conflict 同事务保存，成功后更新本地基线，但不推进同步基线。
- 六种 settle reason 在相应协调器路径有测试，非 null event 经正常 dispatch 处理。

### 15.3 GitHub 和同步

- 测试全部注入 fake fetch，绝不访问真实 GitHub。
- 单模块一个 commit、未知文件保留、受管差集删除。
- 同模块冲突、跨模块三次重试、响应丢失幂等。
- 保存、拉取、上传确认、冲突、同 revision 时间补齐和响应丢失恢复均按规则推进本地/云端时间。
- decode 后 validate。
- 同步四象限、两个显式覆盖方向、普通 pull 不制造假冲突。
- 前后台轮询、不重叠、完整 revision/updatedAt 传递、stop 等待与失败静默。

### 15.4 工程

- `npm test` 独立通过；部署工作流在 build 前测试。
- `npm run build` 通过。
- 生产产物只包含已注册入口，不恢复旧模块资源。
- 测试、夹具和开发工具不访问或修改真实 GitHub 数据。
