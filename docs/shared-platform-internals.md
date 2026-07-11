# Shared 与平台内部规范

## 1. 读者和边界

本文只给维护 Shared、首页认证、持久化和同步基础设施的 agent 阅读。业务模块开发 agent 不需要阅读本文，也不得复制本文中的内部算法；业务模块只读：

1. [通用模块约束](./general-module-constraints.md)；
2. [Shared 模块 SDK 使用指南](./shared-module-sdk-guide.md)；
3. 当前模块设计文档。

本文记录当前平台的固定实现、内部数据结构、安全不变量和 Shared 验收要求。这里的类和字段可以由 Shared 维护任务演进，但 `src/shared/index.ts` 暴露的模块 SDK 契约必须保持稳定或显式升级。

本轮不包含业务 `schemaVersion`、旧格式迁移、自动冲突合并、退出登录或真实 GitHub 数据迁移。

## 2. 代码边界和公共入口

```text
src/shared/index.ts          业务模块唯一入口
src/shared/module/           模块 SDK 门面与定义辅助函数
src/shared/auth/             首页认证与凭据状态
src/shared/history/          完整 payload 历史
src/shared/persistence/      每模块 IndexedDB
src/shared/concurrency/      操作队列与 Web Locks
src/shared/github/           Git Data API 与原子模块仓库
src/shared/sync/             同步协调器与轮询器
src/shared/ui/               公共遮罩、spinner 和阻止页面
```

业务模块只获得 `ModuleRuntime`，不得获得或长期持有 token、client、repository、store、coordinator、gate 或 lease。

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
| 历史容量 | 100 个完整 payload 版本 |
| 远端受管内容 | UTF-8 文本文件 |
| Payload 复制 | 原生 `structuredClone` |

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
3. 移除快捷键和页面监听；
4. 关闭本地 store；
5. 释放 lease；
6. 清空对 coordinator/client/token 的可达引用；
7. 返回首页登录边界。

### 4.3 token 不变量

token 只能存在于认证存储和发往 `https://api.github.com` 的 `Authorization` 请求头。它不得进入 DOM、URL、异常消息、日志、业务 payload、IndexedDB 模块记录、历史、Git commit、测试快照或模拟错误文本。

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
8. 创建并初始化 `SyncCoordinator`；
9. 安装经过 coordinator 的异步 `Ctrl+Z`/`Ctrl+Y`；
10. 创建 revision poller；
11. 注册 auth anonymous 和 `pagehide` 清理；
12. 启动轮询并返回不暴露内部对象的 runtime 门面。

每获得一个资源都必须立即登记逆序清理函数。启动任一步失败都要继续尝试全部清理，且不得用清理错误覆盖原始启动错误。

### 5.2 命令和销毁

runtime 的 undo、redo、save、upload、pull、冲突解决和轮询状态写入经过同一命令尾队列。快速快捷键必须串行，不能绕过 `settle` 直接操作 `StagingHistory`。

`dispose()` 是幂等、one-shot 的：先把状态设为 disposing，再停止新命令、停止并等待 poller、等待命令尾和 gate、关闭 coordinator/store、释放 lease，最后清空内部引用并进入 disposed。

401 回调可能发生在当前 gate 命令内部，因此只能异步触发 dispose，不能在 GitHub 请求栈中同步等待自身命令。

正常页面关闭由 `pagehide` 自动调用 dispose。单页应用卸载模块时由宿主显式调用。

### 5.3 平台与测试注入

`ModuleRuntimeEnvironment` 可以注入 `AuthService`、fetch、IndexedDB factory、LockManager、Document、Window、随机数、时钟、UUID、reload 和认证返回回调。生产业务模块不得传入这些依赖；它们只用于平台宿主和确定性的 Shared 测试。

`autoStartPolling: false` 只用于测试启动和资源清理，不是业务模块关闭同步的开关。

## 6. Payload、定义和历史内部规则

`ModuleDefinition<T>` 同时是校验、内容标识和远端 codec：

```ts
interface ModuleDefinition<T> {
  readonly moduleId: string;
  createEmpty(): T;
  validate(value: unknown): T;
  contentKey(payload: T): string;
  encode(payload: T): ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;
  decode(files: ReadonlyMap<string, string>): T | Promise<T>;
}
```

所有进入 Shared 的 payload 先 validate，再 structured clone，并对 clone 后形态复验。所有传给模块回调、codec、hooks 和公共 getter 的 payload 都是 clone，不能暴露内部版本引用。

`RemoteModuleRepository.pull()` 在 decode 后独立调用 validate；`SyncCoordinator` 在写入本地前再次验证和计算 hash。两层校验不能因当前调用路径看似重复而删除。

`StagingHistory`：

- 内部只保存完整 payload clone 和 content key；
- current/undo/redo 返回新的 clone；
- content-key 回调只获得 clone；
- 空提交不剪掉 redo 分支；
- 非空提交先剪 redo，再加入版本；
- 超过 100 步时淘汰最旧版本；
- 本地 baseline 只保存 key，不成为历史步骤。

content hash 是 `SHA-256(UTF-8(contentKey))`。业务 payload 不包含保存或同步元数据，也不包含业务 `schemaVersion`。

## 7. IndexedDB 内部记录

每模块一个数据库、一个完整记录：

```ts
interface ModuleRecord<T> {
  payload: T;
  contentHash: string;
  localRevision: string;
  lastSyncedContentHash: string | null;
  lastSyncedRemoteRevision: string | null;
  pendingUpload: {
    localRevision: string;
    contentHash: string;
    nextRemoteRevision: string;
    updatedAt: string;
  } | null;
  conflict: {
    observedRemoteRevision: string | null;
    detectedAt: string;
  } | null;
}
```

`localRevision` 是每次成功替换完整记录时生成的新 UUID。所有写入使用单个 read-write 事务和整条记录 compare-and-swap。写入前先 structured clone；事务、clone 或校验失败时不得推进 payload、revision 或任何 baseline。

CAS 的输入和返回值都必须 clone，公共 snapshot 中的 pending/conflict 也必须 clone，防止 readonly 类型之外的运行时别名修改。

历史不跨刷新保存；pending upload 和 conflict 必须跨刷新保存。

## 8. OperationGate、公共 UI 和编辑锁

同一 runtime 的持久化操作由 `OperationGate` 串行执行：

- local：`appRoot.inert = true`，不显示遮罩；
- cloud：root inert、模糊，并在 body 添加公共全页 spinner/overlay；
- 成功、失败或 presentation 初始化中途抛错都在 finally 清理。

`DomOperationGatePresentation` 静态导入唯一的 `operationGate.css`。所有模块维护同一份源代码和样式，但每个 runtime 创建独立实例；不得使用跨模块全局 spinner 单例。

编辑锁使用 `navigator.locks.request(name, { mode: "exclusive", ifAvailable: true })` 并让 callback 在整个会话期间 pending。第二标签只显示公共 blocker。不支持 Web Locks 时禁止编辑；不得使用 localStorage、BroadcastChannel 或心跳降级锁。

## 9. GitHub 远端格式

### 9.1 revision.json

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

### 9.2 单次原子上传

上传只用 Git Data API：

1. 读取 `main` 当前 ref、commit 和根 tree；
2. 在访问 GitHub 前把 next revision、content hash 和时间写入 `pendingUpload`；
3. 为全部新受管文本和新 `revision.json` 创建 blob；
4. 以当前根 tree 为 base tree，写入新文件和清单，并仅删除旧受管差集；
5. 创建一个以当前头为唯一 parent 的 commit；
6. 以 `force: false` 更新 `refs/heads/main`；
7. 确认 revision 后，在一个本地事务中更新同步 baseline 并清空 pending。

一次模块上传只有一个可见 commit。不得逐文件使用 Contents API，不得 force push。

### 9.3 ref 竞态和幂等

非强制 ref 更新失败后重新读取新头：

- 模块 revision 已等于 pending revision：响应丢失，幂等确认成功；
- 模块 revision 仍是期望值：其他模块推进了 main，以新头重建，最多重试三次；
- 模块 revision 变成其他值：同模块冲突，不自动覆盖。

网络结果不确定时保留 pending revision。`local-wins` 也只能基于最新头创建一个新 commit，不能 force 更新。

## 10. SyncCoordinator 状态机

状态判断使用：

- `cloudChanged`：远端 revision 与 `lastSyncedRemoteRevision` 不同；
- `localChanged`：暂存或本地内容 hash 与 `lastSyncedContentHash` 不同。

| cloudChanged | localChanged | 内部行为 |
| --- | --- | --- |
| 否 | 否 | unchanged |
| 否 | 是 | 保留本地，等待上传 |
| 是 | 否 | cloud gate 拉取、原子替换 IndexedDB、reload |
| 是 | 是 | CAS 持久化 conflict |

普通 pull 必须先 reconciliation pending upload，再比较远端 baseline；“云端未变、本地已变”不得制造假冲突。

冲突存在时允许继续本地 commit/save，但 upload 或主动 pull 前必须显式 resolve：

- local-wins：结算并保存当前暂存 payload，再 overwrite 当前模块；
- cloud-wins：拉取最新完整模块，清空 pending/conflict，写入本地并 reload。

所有传给远端 port 的 payload 都必须 clone；所有传给模块 hooks 的 payload/conflict 也必须隔离。

## 11. 轮询

poller 使用上一次完成后再安排下一次的一次性 timer：

- 前台：60 秒 + 0–15 秒随机量；
- 后台：5 分钟 + 0–60 秒随机量；
- visibilitychange 双向重排；
- online 立即安排一次。

普通网络失败静默等待下一轮。GitHub client 的 401 回调负责认证失效。

`stop()` 必须 abort 当前 signal、等待 in-flight 结束，并在停止后禁止调用 `onRevision` 或认证回调。`RemoteModuleRepository.readRevision(signal)` 和 GitHub branch/blob 读取必须贯通 AbortSignal，避免 runtime dispose 后继续写已关闭 store。

## 12. 失败不变量

任何失败路径都必须满足：

1. token 不进入输出、日志、业务状态或持久化记录；
2. 未提交的 IndexedDB 事务不推进任何 baseline；
3. 未确认 GitHub commit 不推进同步 baseline；
4. 保存失败不清空历史或 dirty；
5. 上传、拉取和覆盖失败不自动选择冲突方向；
6. inert、spinner 和 overlay 必须恢复；
7. 未知文件不删除，main 不 force-update；
8. 损坏 payload 在 validate 边界停止，不尝试旧格式迁移；
9. runtime 启动失败逆序释放已经获得的每一个资源；
10. dispose 后不得有 poller、listener、lease、store 或 token 可达链继续存活。

## 13. Shared 验收

### 13.1 模块 SDK

- 业务模块只从 Shared 根入口导入。
- 一次启动自动装配 auth、lease、gate、store、repository、coordinator、shortcuts 和 poller。
- ready、authentication-required、blocked、unsupported 都有集成测试。
- 初始化失败会释放锁并允许重试。
- 401 会清凭据、等待命令结束、dispose 并返回登录边界。
- 快速快捷键经过异步 settle 串行执行。
- 公共 spinner/overlay 由 runtime 自动使用。

### 13.2 历史和持久化

- 100 步、分支、保存后撤销、回到 baseline clean、刷新清空正确。
- JSON 和非 JSON structured-clone payload 都有测试。
- 调用者、contentKey、codec、hook 和 snapshot 都不能修改内部引用。
- 每模块数据库隔离，CAS 原子，失败不推进，pending/conflict 跨刷新。

### 13.3 GitHub 和同步

- 测试全部注入 fake fetch，绝不访问真实 GitHub。
- 单模块一个 commit、未知文件保留、受管差集删除。
- 同模块冲突、跨模块三次重试、响应丢失幂等。
- decode 后 validate。
- 同步四象限、两个显式覆盖方向、普通 pull 不制造假冲突。
- 前后台轮询、不重叠、stop 等待与失败静默。

### 13.4 工程

- `npm test` 独立通过；部署工作流在 build 前测试。
- `npm run build` 通过。
- 生产产物只包含已注册入口，不恢复旧模块资源。
- 不新增 `AGENTS.md`，不访问或修改真实 GitHub 数据。
