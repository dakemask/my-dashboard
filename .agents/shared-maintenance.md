# Shared 与平台维护规范

Shared 的可观察行为以 [持久化模块公共契约](./persistent-module-contract.md) 为准；本文记录其内部结构和维护约束。

## 1. Shared 的职责与非职责

### 1.1 职责

Shared 为所有持久化模块提供统一平台能力：

- GitHub 登录、凭据恢复和失效处理；
- 模块 runtime 门面和资源生命周期；
- 当前完整 payload 与页面内可逆 event 历史；
- 每模块独立的本机完整数据保存；
- 单模块编辑锁和持久化操作串行化；
- GitHub 远端受管文件、原子上传和幂等确认；
- 轮询、同步四象限和持久化冲突；
- 本地操作阻塞、云端 spinner/遮罩和阻止页面。

固定平台约定：

| 项目 | 约定 |
| --- | --- |
| 私人数据仓库 | `my-dashboard-data` |
| 分支 | `main` |
| 模块远端根 | `data/<moduleId>/` |
| 模块清单 | `data/<moduleId>/revision.json` |
| 本地数据库 | `my-dashboard.module.<moduleId>` |
| 编辑锁 | `my-dashboard.module.<moduleId>.editor` |
| 远端业务文件 | UTF-8 文本 |
| clone 边界 | 原生 `structuredClone` |

`moduleId` 必须匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`。目标浏览器必须支持 ES2022、IndexedDB、Web Crypto、Web Locks、`structuredClone`、`inert` 和严格 CSP 所需能力。

### 1.2 非职责

Shared 不定义模块业务 payload、event、快捷键、页面布局或冲突提示外观；不提供业务 `schemaVersion`、旧格式迁移、自动冲突合并、退出登录或真实数据迁移。它也不替模块注册或清理业务 UI/键盘监听。

改变这些边界不是内部重构，必须先形成新的用户决策和公共契约。

## 2. 源码结构、依赖与资源寿命

`src/shared/index.ts` 是业务模块唯一的 TypeScript 入口，其可观察语义由 [持久化模块公共契约](./persistent-module-contract.md) 说明。

`ModuleRuntimeEnvironment` 不从根入口导出。它是平台组合和测试注入点，可替换 auth、fetch、IndexedDB、LockManager、Document、Window、随机数、时钟、UUID、reload 和认证返回回调；生产业务模块不得依赖它。

### 2.1 组件职责

```text
src/shared/index.ts          业务模块唯一入口
src/shared/module/           definition 辅助函数、runtime 门面和平台装配
src/shared/auth/             登录验证、凭据存储和认证状态
src/shared/history/          current payload、event 历史和 JSON content key
src/shared/persistence/      每模块 IndexedDB 记录及 CAS
src/shared/concurrency/      OperationGate 与 Web Locks 编辑租约
src/shared/github/           Git Data API client 与远端模块仓库
src/shared/sync/             SyncCoordinator、content hash 和 revision poller
src/shared/ui/               公共遮罩、spinner 和阻止页面
```

- `module/runtime` 是组合根，拥有 auth subscription、lease、gate、store、repository、coordinator 和 poller。
- `SyncCoordinator` 只依赖本地 store、远端 repository port、history、gate 和 hooks，不依赖业务 DOM。
- `RemoteModuleRepository` 负责远端模块格式；`GitHubGitDataClient` 只负责 GitHub 请求。
- history、persistence、github、concurrency 和 sync 不得依赖任何具体业务模块。
- UI presentation 不决定同步状态；只根据 gate/lease 命令呈现公共状态。

### 2.2 runtime 装配顺序

`startModuleRuntime` 固定按以下顺序取得资源：

1. 创建或注入 `AuthService` 并恢复会话；
2. 无凭据时返回 `authentication-required`；
3. 非等待地申请模块 Web Lock；
4. blocked/unsupported 时只渲染公共阻止页面；
5. 创建 `DomOperationGatePresentation` 和 `OperationGate`；
6. 打开 `ModuleLocalStore`；
7. 使用认证会话创建 GitHub client 与 `RemoteModuleRepository`；
8. 创建并初始化 `SyncCoordinator`；
9. 创建 revision poller；
10. 注册认证失效和 `pagehide` 清理；
11. 启动轮询并返回不暴露内部对象的 runtime。

每取得一个资源就登记逆序清理。任一步失败都继续尝试全部已登记清理，并保留原始启动错误。

### 2.3 runtime 命令与资源所有权

同步 `dispatch(event)` 只在 runtime ready、没有排队命令且 gate 空闲时执行，否则抛出 `ModuleRuntimeBusyError`。undo、redo、保存、同步、冲突解决和轮询观察进入同一命令尾队列。

runtime ready 后先通知一次 snapshot；其后在 dispatch、历史命令、持久化命令和轮询处理结束后通知。通知发生在状态已经成功推进或失败保持原状之后，不属于事务；观察者异常被隔离。disposing/disposed 后停止通知。

`dispose()` 幂等且 one-shot：进入 disposing，禁止新命令，停止并等待 poller，等待命令尾和 gate，关闭 coordinator/store，释放 lease，清空内部引用，最后进入 disposed。

## 3. 内部状态与持久化格式

### 3.1 StagingHistory

历史内部持有：

- 一个 current 完整 payload；
- current 对应的 content key；
- 最近本地保存基线的 key；
- 一组 `{ forward, inverse, beforeKey, afterKey }` 条目；
- 当前 position 和模块选择的 capacity。

它不长期保存每一步完整 payload。before/after payload 只在一次 dispatch、undo 或 redo 的计算期间作为 clone 存在。正整数 capacity 只淘汰最旧 event 对；`"unlimited"` 不按数量淘汰。event 历史从不进入 IndexedDB 或 GitHub。

### 3.2 IndexedDB envelope

每模块数据库 `my-dashboard.module.<moduleId>` 只有一个对象仓库和一条完整记录：

| 字段 | 含义 |
| --- | --- |
| `payload` | 最近成功保存的完整业务 payload |
| `contentHash` | 该 payload 的内容 hash |
| `localRevision` | 本地 CAS 令牌 |
| `localSavedAt` | 当前本机版本保存时间 |
| `lastSyncedContentHash` | 最近同步基线的内容 hash |
| `lastSyncedRemoteRevision` | 最近完成同步的模块 revision |
| `lastSyncedRemoteUpdatedAt` | 该云端 revision 的时间 |
| `pendingUpload` | 尚未确认的上传意图，含本地 revision/hash、下一远端 revision 和时间 |
| `conflict` | 观察到的远端 revision/时间和冲突发现时间 |

数据库版本保持 v1。旧记录缺少 `localSavedAt`、`lastSyncedRemoteUpdatedAt` 或 conflict 的远端时间时，读取为 null，不升级数据库版本。业务 payload 没有 Shared 注入的 schemaVersion，也没有通用迁移分支。

### 3.3 远端模块格式

每个模块根目录必须有：

```text
data/<moduleId>/revision.json
```

清单只包含：

```text
revision: 非空字符串
updatedAt: ISO 8601 时间
managedFiles: 按路径排序的相对路径数组
```

`managedFiles` 不包含 `revision.json`。路径必须规范、不能越出模块根，且不能大小写冲突或形成文件/目录父子冲突。codec 只能管理 UTF-8 文本。

未知文件永远保留；只有旧清单中存在、而新清单中消失的受管文件才能删除。清单缺失不授权接管目录内未知文件。清单损坏、受管文件缺失或 decode/validate 失败必须停止。

### 3.4 gate、lease、poller 与 runtime 状态

- `OperationGate` 同一时间只执行一个 local/cloud 操作。local 设置根节点 inert；cloud 额外模糊根节点并向 body 添加全页 overlay/spinner。
- `ModuleEditorLease` 使用 `navigator.locks` 的 exclusive + ifAvailable，并让回调在整个编辑会话 pending。第二标签为 blocked；不支持 Web Locks 为 unsupported，没有竞态降级锁。
- poller 只有 stopped、waiting 和 in-flight 三类有效状态；同一 poller 不重叠请求。
- runtime 状态只允许 starting → ready → disposing → disposed。

## 4. 核心流程与原子性

### 4.1 history dispatch、undo 与 redo

dispatch 的原子流程：

1. clone current 与输入 event；
2. 调用模块 apply；
3. validate 并计算新 content key；
4. key 未变化时返回 no-op，不调用 invert、不剪 redo；
5. 调用 invert，clone 并验证 inverse；
6. 在临时条目数组中剪掉 redo，追加 forward/inverse/key；
7. 应用 capacity；
8. 最后一次性提交 current、key、entries 和 position。

undo 应用保存的 inverse，并要求结果 key 等于 entry.beforeKey；redo 应用 forward，并要求结果 key 等于 afterKey。任意 clone、回调、校验或 key 比较失败都不提交临时状态。

### 4.2 本机保存与 CAS

`ModuleLocalStore.compareAndSwap(expectedLocalRevision, nextEnvelope)` 在一个 readwrite 事务中读取唯一记录、比较令牌并写入完整新 envelope。失败或事务 abort 不更新内存状态。

保存先 settle 并 dispatch 返回 event，再计算 current 的 content hash。CAS 成功后才更新 history 本地基线；保存不改变同步基线或 event 队列。

双方变化形成冲突时，settle 后的当前完整 payload、content hash、localSavedAt 与 conflict 必须在同一次 CAS 中保存；成功后才把该 payload 标记为本地保存基线。这样刷新不会丢失冲突的本地一侧，但不会推进同步基线。

### 4.3 GitHub 单 commit 上传

上传只用 Git Data API：

1. 读取当前 `main` ref、commit 和根 tree；
2. 在网络提交前持久化 next revision、content hash 和时间到 pendingUpload；
3. 为全部新受管文本和新的 `revision.json` 创建 blob；
4. 以当前根 tree 为 base 创建新 tree，只删除旧受管差集；
5. 创建一个以当前头为唯一 parent 的 commit；
6. 以 `force: false` 更新 `refs/heads/main`；
7. 确认 revision 后，用一次本地 CAS 推进同步基线并清空 pending。

一次模块上传只有一个可见 commit。不得使用 Contents API 逐文件提交或 force push。

`main` ref 是可变资源，其 GET 必须使用 `cache: "no-store"`，避免上传前缓存的旧 ref 在 PATCH 成功后被拉取或轮询误读。按 SHA 寻址的 commit、tree 和 blob 不可变，可以缓存。

非强制 ref 更新失败后重新读取新头：

- 模块 revision 已等于 pending revision：按响应丢失进行幂等确认；
- 模块 revision 仍等于期望值：说明其他模块推进了 main，以新头重建，最多重试三次；
- 模块 revision 变成其他值：同模块冲突，不自动覆盖。

网络结果不确定时保留 pending。后续 readRevision 观察到 pending revision 时确认成功；看到同步基线以外的第三个 revision 时建立冲突。

### 4.4 SyncCoordinator

初始化优先读取本机 envelope；本机不存在时在 cloud gate 中拉取远端，远端也不存在时使用 `createEmpty()`，随后初始化本机记录和空历史。

同步判断：

| cloudChanged | localChanged | 行为 |
| --- | --- | --- |
| 否 | 否 | unchanged |
| 否 | 是 | 保留本地，等待上传 |
| 是 | 否 | 拉取完整模块并 reload |
| 是 | 是 | 保存当前本地一侧并建立 conflict |

`localChanged` 同时考虑页面 history dirty 与已保存 payload 相对同步基线的变化。上传必要时先保存；普通 pull 先比较 revision，再在本地干净时替换完整 envelope。`local-wins` 基于最新远端头创建非强制 commit；`cloud-wins` 拉取完整模块并清空旧页面历史。

所有完成路径必须一致推进 revision 与 updatedAt：上传确认、响应丢失恢复、拉取、冲突观察和同 revision 时间补齐都不能让版本号与时间来自不同远端观察。

### 4.5 revision poller

- 页面可见：约 60 秒加 0–15 秒随机量；
- 页面隐藏：约 5 分钟加 0–60 秒随机量；
- visibilitychange 后重排下一次等待；
- 每轮完整读取 revision 与 updatedAt；普通网络失败静默等待下一轮；
- 同一 poller 不重叠；gate busy 时协调器返回 busy；
- stop 必须 abort 当前 signal、等待 in-flight 结束，并阻止停止后的回调。

### 4.6 dispose 与认证失效

正常 pagehide 异步触发 dispose。SPA 宿主显式等待 dispose。HTTP 401 回调可能发生在当前 gate 命令内部，因此只能异步启动清理，不能在请求栈中等待自身命令。

认证变为 anonymous 时停止轮询、等待当前命令和 gate、移除 Shared listener、关闭 store、释放 lease、清除 coordinator/client/token 可达引用，再返回首页登录边界。

## 5. 安全与失败不变量

### 5.1 登录与凭据

用户只输入 GitHub 用户名和 token；以下验证全部成功后才保存凭据：

1. `GET /user` 验证 token 身份；
2. 返回 login 与输入用户名按 GitHub 大小写规则一致；
3. 读取该用户的 `my-dashboard-data`；
4. owner 一致且仓库为 private；
5. 权限同时具有 pull/read 与 push/write；
6. `refs/heads/main` 存在且可读。

验证不得创建测试文件或 commit。只有明确 HTTP 401 清除凭据；403、限流、离线或服务异常不得误清。产品不提供退出按钮。

token 只能存在于认证存储和发往 `https://api.github.com` 的 Authorization 请求头。它不得进入 DOM、URL、异常、日志、业务 payload/event、本机模块记录、Git commit、测试快照或模拟错误。

### 5.2 CSP 与公共 UI

首页和模块保持严格 CSP：脚本/样式只允许 self，连接只允许 self 与 GitHub API，不允许 unsafe-eval、任意 token 发送目标、object 或第三方 form action。

严格 CSP 页面必须在 HTML 中外链唯一的 `operationGate.css`。不得从 TypeScript 动态导入：Vite 开发服务器会把它转换为 CSP 拒绝的内联 style。`DomOperationGatePresentation` 只创建 DOM、切换公共 class 和 finally 清理；每个 runtime 独立实例，不使用跨模块全局 spinner 单例。

### 5.3 不变量

1. payload、event、codec、history 回调、hooks 和 snapshot 之间不共享可被调用者修改的内部引用；
2. content key 与编码必须覆盖同一业务语义；
3. apply/invert/validate/clone 失败不推进历史；
4. 本机事务失败不推进内存 envelope 或本地基线；
5. 未确认上传不推进同步基线；
6. 冲突不自动选择方向或合并；
7. gate 成功、失败或 presentation 中途异常都恢复 inert、spinner 和 overlay；
8. 未知远端文件不删除，main ref 不 force-update；
9. 损坏 payload 在 validate 边界停止，不猜测修复或迁移；
10. runtime 启动失败逆序释放全部已取得资源；
11. dispose 后没有 poller、Shared listener、lease、store 或 token 可达链继续存活；

## 6. 修改要求与验证

### 6.1 公共接口兼容性

- `src/shared/index.ts` 根出口的删除、改名、签名变化或可观察语义变化都属于破坏性修改。
- runtime 属性/方法、启动四状态、SettleReason、ProjectionReason、SyncActionResult、snapshot 字段和 conflict 形态同样属于公共契约。
- 内部目录、类和算法可以重构，但不能改变公共契约承诺的状态流、失败保证或资源清理。
- `operationGate.css` 的公共 class/加载约定是页面接入契约；改变时必须同步修改所有持久化页面。
- IndexedDB envelope 或远端文件格式变化必须单独决定兼容策略。当前没有业务 schemaVersion 或通用旧格式迁移，不得悄悄解释旧数据。
- 修改公共边界时，源码、[持久化模块公共契约](./persistent-module-contract.md)、[接入指南](./new-persistent-module-guide.md)、受影响模块文档和测试必须在同一次任务更新。

### 6.2 验证范围

#### runtime 与生命周期

- ready/authentication-required/blocked/unsupported；启动失败逆序清理；401 异步失效；dispose 幂等。
- dispatch busy 边界、命令尾串行、snapshot 通知时机、观察者异常隔离和 dispose 后停止通知。
- Shared 不注册 keydown，业务调用历史和保存方法仍工作。

#### history 与 clone

- 多种正整数容量、unlimited、no-op 保留 redo、撤销后分支、基线 clean 和刷新清空。
- forward/inverse 可逆与 key 校验；apply/invert/clone/validate/contentKey 失败原子性。
- JSON 与非 JSON payload/event；所有公共边界引用隔离。

#### IndexedDB

- 每模块隔离、单记录 CAS、事务失败不推进、pending/conflict 跨刷新。
- v1 旧记录缺失三个时间字段时读取为 null。
- 冲突时 payload/hash/conflict 同事务保存并正确更新本地基线。

#### GitHub

- 全部注入 fake fetch，绝不连接真实仓库。
- 单模块单 commit、未知文件保留、受管差集删除、非法路径拒绝和 decode 后 validate。
- 同模块冲突、跨模块最多三次重试、响应丢失幂等、main ref no-store。

#### 同步与轮询

- 四象限、两个覆盖方向、pending 恢复、普通 pull 不制造假冲突。
- 保存/上传/拉取/冲突/时间补齐正确推进 revision 与 updatedAt。
- 前后台间隔、visibility 重排、不重叠、AbortSignal、stop 等待和网络失败静默。

#### 认证、安全、锁和公共 UI

- 登录全部成功条件与各失败条件；长期恢复；401 与 403 区分；token 不出现在 DOM、日志或错误。
- 第二标签阻止、锁释放、不支持浏览器阻止编辑。
- local 仅 inert，cloud 全页遮罩；presentation 异常和命令异常后完整恢复；持久化页面 HTML 引用 `operationGate.css`。

#### 工程

修改 Shared 后按 [README](../README.md) 运行项目规定的测试与构建。
