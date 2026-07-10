# 通用模块技术规范

## 1. 范围与规范用语

本文规定 dashboard 首页和未来业务模块共同遵守的认证、状态、持久化、并发与同步协议。它是实现和测试的依据；模块特有的 payload 与交互规则由各模块文档补充。

文中的“必须”是不可省略的行为，“不得”是实现不变量，“可以”表示不影响协议的实现选择。

本轮明确不包含：业务 `schemaVersion`、旧格式迁移、自动冲突合并、退出登录、新 Mind Map 或碎片想法模块，以及对真实 GitHub 数据的迁移或删除。

## 2. 固定约定

| 项目 | 固定值或规则 |
| --- | --- |
| GitHub 仓库 | 当前登录用户拥有的私有仓库 `my-dashboard-data` |
| Git 分支 | `main` |
| 模块根目录 | `data/<moduleId>/` |
| 模块清单 | `data/<moduleId>/revision.json` |
| 本地数据库 | 每模块独立的 `my-dashboard.module.<moduleId>` |
| 历史容量 | 最多 100 个完整 payload 版本 |
| 编辑互斥 | Web Locks；同一 `moduleId` 同时只允许一个编辑标签页 |

`moduleId` 必须匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`。它不能包含斜杠、点路径、空白或大小写变体，因此模块根目录只能由受信任的 `moduleId` 派生，不能由任意路径输入覆盖。

业务 payload 必须是 JSON 兼容值：只能由 `null`、布尔值、有限数字、字符串、数组和普通字符串键对象组成。不得包含 `undefined`、`NaN`、无限值、函数、类实例、DOM 引用或循环引用。内容比较使用确定性键排序后的规范 JSON 与 SHA-256，不依赖对象引用相等。

## 3. 统一 GitHub 登录

### 3.1 凭据与首页状态

用户只输入 GitHub 用户名和 personal access token。仓库名和分支不可编辑。token 输入框必须使用 `type="password"`。

未认证时，首页只渲染登录卡片；认证成功后才渲染模块首页。当前模块注册表为空时，首页显示“暂无可用模块”。凭据长期保存在 `localStorage`，刷新和浏览器重启后复用；产品不提供退出功能。

凭据只能存在于认证存储和发往 `https://api.github.com` 的 `Authorization` 请求头中。token 不得进入：

- DOM 文本、URL、异常消息或用户可见错误；
- `console`、遥测或调试日志；
- 业务 payload、IndexedDB 模块记录、历史版本或 Git commit；
- 测试快照和模拟请求失败文本。

展示错误时必须使用本地定义的安全消息，不得直接展示 GitHub 原始响应体、请求头或捕获异常的任意序列化结果。

### 3.2 首次验证顺序

只有以下检查全部成功后，凭据才可写入 `localStorage`：

1. 用 token 请求 `GET /user`，确认 token 可识别 GitHub 身份。
2. 将返回的 `login` 与输入用户名按 GitHub 不区分大小写的规则比较，必须是同一用户。
3. 请求 `GET /repos/<username>/my-dashboard-data`，确认仓库存在、归属该用户且 `private === true`。
4. 确认仓库权限同时允许读取和推送；至少要求 GitHub 返回的权限信息包含 pull/read 与 push/write 能力。
5. 请求 `main` 分支或 `refs/heads/main`，确认分支存在且可读。

验证过程不得创建测试文件或测试 commit。分支保护等最终写入限制由真实上传操作报告。

恢复已保存凭据时也要经过认证边界。构造 `GitHubGitDataClient` 时必须把当前 `AuthService.invalidate` 作为必填的凭据失效回调；客户端仅在 GitHub 明确返回 `401` 时调用它。登录 gate 订阅认证状态，因此回调会清除已保存凭据、停止后续模块操作并重新渲染登录页。限流、`403`、GitHub 服务异常、离线或普通网络错误不得被误判为凭据失效，也不得清除凭据。

### 3.3 CSP

首页必须配置 Content Security Policy。脚本只能来自本站，网络连接只允许本站和 `https://api.github.com`；同时禁止对象、外部 base、外部表单目标和页面嵌入。最低约束等价于：

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

实现不得为方便调试加入 `unsafe-eval`，也不得把 token 拼入任何资源 URL。

## 4. Shared 边界与稳定契约

Shared 必须按 `auth`、`history`、`persistence`、`concurrency`、`github`、`sync` 和 `ui` 分离。业务模块依赖这些公开契约，而不是依赖其他边界的内部实现。

### 4.1 `ModuleDefinition<T>`

每个模块提供一个定义对象，语义契约如下：

```ts
interface ModuleDefinition<T> {
  readonly moduleId: string;
  createEmpty(): T;
  validate(value: unknown): T;
  encode(payload: T): ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;
  decode(files: ReadonlyMap<string, string>): T | Promise<T>;
}
```

`encode` 和 `decode` 必须是确定、无损且可往返的；解码后必须再次运行 `validate`。文件路径必须唯一、规范化、位于模块根内，且不能是 `revision.json`。编码器不得读取或生成其他模块的路径。

业务 payload 在历史、IndexedDB 和云端解码结果中必须保持同一业务 schema。远端可以把一个 payload 编码成多个文件，但不得把保存、同步或认证元数据混入 payload。

### 4.2 `StagingHistory<T>`

`StagingHistory<T>` 至少公开以下稳定能力：

```ts
interface StagingHistory<T> {
  readonly current: T;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  commit(next: T): void;
  undo(): T;
  redo(): T;
}
```

历史实现必须能在本地保存成功后更新“本地基线”；同步协调器另行保存同步基线。`dirty` 始终由 `hash(current) !== contentHash` 计算；“已同步”始终由当前/本地 hash 与 `lastSyncedContentHash` 的关系计算。它们不是随历史步骤保存的可变标签。

历史的完整规则见第 5 节。

### 4.3 `ModuleLocalStore<T>`

每个实例只操作 `my-dashboard.module.<moduleId>`。它必须提供读取或初始化完整模块记录、原子替换完整记录，以及在同一 read-write 事务中更新冲突或待确认 revision 的能力。业务模块不得直接访问其 IndexedDB object store。

### 4.4 `RemoteModuleRepository<T>`

远端仓库必须由 `ModuleDefinition<T>` 和已认证 GitHub 客户端构造，并提供下列语义操作：

- 读取固定 commit 视图下的模块 revision；
- 拉取清单列出的全部受管文件，解码并验证完整 payload；
- 在期望的云端 revision 基础上比较并上传本地 payload；
- 仅在用户明确选择 `local-wins` 后以本地模块覆盖云端受管文件。

所有上传都必须走第 8 节的 Git Data API 原子 commit；“覆盖”也不能 force-update Git ref。

### 4.5 `SyncCoordinator<T>`

同步协调器是历史、本地存储与远端仓库之间唯一的工作流编排者，至少提供：

- 初始化当前模块会话；
- 将当前暂存 payload 保存到本地；
- 上传已保存的本地 payload；
- 执行一次轮询并按同步矩阵处理；
- 持久化冲突；
- 用 `local-wins` 或 `cloud-wins` 解决冲突。

协调器不得让实时状态或暂存状态直接上传到 GitHub。所有上传内容必须先成为本地数据层中的完整记录。

### 4.6 `OperationGate` 与 `ModuleEditorLease`

`OperationGate` 串行化同一页面中的持久化操作，并把操作分为 `local` 和 `cloud` 两种 UI 模式。无论成功、失败或取消，都必须在 `finally` 路径释放页面阻塞。

`ModuleEditorLease` 负责获得和维持模块级 Web Lock。只有持有 lease 的页面才能创建可编辑会话；具体规则见第 7 节。

### 4.7 `ui` 适配边界

Shared 状态和同步逻辑不得直接查询模块 DOM。`ui` 边界由页面注入，至少能表达应用根节点的 `inert` 状态、cloud 遮罩与 spinner，以及“已有同模块编辑页”和“浏览器不支持安全锁”两种阻止页面。`OperationGate` 只通过该适配边界切换表现，适配器本身不持有业务 payload、凭据或同步决策。

## 5. 暂存历史、基线与快捷键

### 5.1 完整不可变版本

打开页面时，IndexedDB 当前 payload 是历史的第一步。每次 `commit` 接收整个合法 payload 的不可变快照，而不是 patch、命令对象或 DOM 状态。实现必须克隆输入，不能因调用者之后修改对象而改变旧版本；对与当前内容相同的 payload 提交不得制造空历史步骤。

一个用户语义上的复合动作只提交一步。历史最多保留 100 个版本，超出时丢弃最旧版本。

从 `A → B → C` 撤销到 `B` 后提交 `D`，必须丢弃原 redo 分支，结果为 `A → B → D`。

### 5.2 保存和同步基线

本地保存不清空、不重建也不截断历史。保存成功只把所保存 payload 的 hash 设为新的本地基线；失败时基线完全不动。因此用户可以在保存后继续撤销，也可以撤销回保存前版本。

当前版本的 hash 再次等于本地基线时，`dirty` 自动变为 false；等于同步基线时，“已同步”自动成立。状态判断不能依赖“最后执行的命令是保存/上传”之类的布尔标记。

刷新页面后不恢复旧历史。系统从 IndexedDB 当前 payload 建立只含一个初始版本的新队列。

### 5.3 通用快捷键

通用历史只处理精确的 `Ctrl+Z` 和 `Ctrl+Y`：

- 即使焦点位于 `input`、`textarea` 或可编辑元素，也操作模块历史；
- 识别后阻止浏览器原生文本历史，避免出现两套撤销状态；
- `Ctrl+Shift+Z` 不是重做别名，不得派发模块重做；
- 含 `Alt`、`Meta` 或不符合精确修饰键组合的按键不得触发模块历史。

模块可以在执行通用撤销/重做前结算自身实时交互，但不得改变上述按键定义。

## 6. IndexedDB 持久化

每个模块使用独立数据库 `my-dashboard.module.<moduleId>`，数据库内只保存一份完整模块记录。逻辑结构如下：

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

`localRevision` 是每次完整 IndexedDB 记录事务成功后生成的新 UUID，用于整条记录的 compare-and-swap；业务 payload 或同步元数据任一发生持久化变化时都会更新它，但它不进入业务 payload。

`contentHash` 必须与同一记录中的 payload 匹配。`lastSyncedContentHash` 和 `lastSyncedRemoteRevision` 表示最后一次已确认两端一致的基线。`pendingUpload` 在访问 GitHub 前持久化，用于响应丢失后的幂等确认。`conflict` 必须跨刷新保留。

每次读取、初始化或修改都必须在单个 IndexedDB 事务内处理整份记录。事务失败、abort 或校验失败时，旧记录必须保持完整，不能推进 `localRevision`、本地基线或任何同步基线。业务 payload 不包含 `schemaVersion`，实现不读取或迁移旧业务格式。

## 7. 页面内串行化、阻塞表现与编辑锁

### 7.1 操作阻塞

同一页面的本地保存、上传、拉取和覆盖必须经 `OperationGate` 串行执行，不能同时修改 IndexedDB 或同步元数据。

- 本地保存期间：应用根节点设为不可交互（`inert`），但不显示遮罩或 spinner。
- 上传、拉取和任一方向的云端覆盖期间：应用根节点不可交互，并显示带模糊背景的全页遮罩和 spinner。
- 操作失败：保留用户内容、历史、`dirty`、待上传和冲突信息；解除阻塞后允许用户手动重试。

普通的 revision 轮询检查本身不遮罩页面；一旦它决定自动拉取并写入本地，拉取阶段必须进入 cloud 模式。所有阻塞状态都必须用 `finally` 恢复，不能因异常留下永久 `inert` 或遮罩。

### 7.2 单模块编辑 lease

锁名固定从模块派生，例如 `my-dashboard.module.<moduleId>.editor`。页面使用 `navigator.locks.request(name, { ifAvailable: true }, callback)` 非等待地请求锁，并让 callback 在整个编辑会话期间保持 pending。

- 成功获得锁：才可初始化编辑器和写入数据。
- 同一模块第二个标签页未获得锁：只显示阻止页面，不创建可编辑状态。
- 不同 `moduleId`：可以同时编辑。
- 页面关闭或显式销毁编辑器：释放 lease。
- 浏览器不支持 Web Locks：禁止编辑并显示不支持页面。

不得使用 `localStorage`、BroadcastChannel 或定时心跳模拟降级锁，因为这些方案不能提供本规范要求的互斥安全性。

## 8. GitHub 远端格式与原子 commit

### 8.1 `revision.json`

每个已初始化模块根目录必须包含：

```json
{
  "revision": "唯一 revision 标识",
  "updatedAt": "ISO 8601 UTC 时间",
  "managedFiles": ["按字典序排列的相对文件路径"]
}
```

`managedFiles` 只列业务编码器管理的文件，路径相对于 `data/<moduleId>/`，使用 `/`，必须已排序、无重复且不能包含 `revision.json`。`revision.json` 本身由 shared 管理。

远端未知文件必须保留。删除集合只能是“旧清单 `managedFiles` 中存在、但新清单中消失”的路径。没有列入旧清单的文件，即使位于同一模块目录，也不得删除或改写。

缺少 `revision.json` 表示该模块尚未在云端初始化，不表示可以接管目录内未知文件。清单损坏、路径越界或受管 payload 解码失败必须作为安全错误停止操作，不能猜测修复。

### 8.2 单次上传算法

上传必须使用 GitHub Git Data API，并以固定的 `main` 头作为一致性快照：

1. 读取 `refs/heads/main` 的当前 commit SHA、根 tree SHA，以及该 commit 视图下的模块清单。
2. 将本地完整 payload 编码为新的受管文件集合；在访问 GitHub 前生成下一 revision，并把它与 `contentHash`、`updatedAt` 和对应本地 revision 一起写入 `pendingUpload`。
3. 为每个新业务文件创建 blob，并为新的 `revision.json` 创建 blob。
4. 以当前根 tree 为 `base_tree` 创建新 tree：写入全部新受管文件和清单；对“旧受管、新集合已不存在”的文件写入删除 entry；不触碰未知文件。
5. 创建一个 Git commit，父 commit 只能是步骤 1 读取的当前头。
6. 使用 `force: false` 将 `refs/heads/main` 更新到新 commit。
7. 确认远端清单已经是 pending revision 后，在一个本地事务中更新 `lastSyncedRemoteRevision`、`lastSyncedContentHash` 并清空 `pendingUpload`。

一次模块上传只能产生一个可见 Git commit。不得逐文件调用 Contents API 制造部分完成状态，也不得 force push。

### 8.3 ref 竞态和跨模块重试

非强制 ref 更新因头部变化失败时，必须重新读取新头和该头下的模块清单：

- 远端 revision 等于本次 pending revision：说明带有该唯一 revision 的 commit 已成功但响应丢失，按幂等成功确认，不再创建 commit。
- 远端 revision 仍等于本次上传开始时的期望 revision：说明其他模块更新了 `main`，以新头重建 tree 和 commit；竞态后最多自动重试三次，初次尝试不计入重试次数。
- 远端 revision 已变为其他值：说明同一模块被并发修改，进入冲突，不自动覆盖。

超过跨模块重试上限时返回可重试错误，不伪装为成功。网络结果不确定时保留 `pendingUpload`；下一次上传必须先检查并确认旧 pending revision，不能直接丢弃它或生成无法判定的新 revision。

显式 `local-wins` 仍使用最新头、一个新 commit 和非强制 ref 更新。解决过程中若同一模块再次变化，必须重新评估冲突，不能 force 覆盖整个分支。

## 9. 同步状态机

### 9.1 判断基准

每次同步检查计算两个事实：

- `cloudChanged`：当前远端 revision 与本地记录的 `lastSyncedRemoteRevision` 不同；
- `localChanged`：当前暂存 payload（没有活动会话时为本地 payload）的 hash 与 `lastSyncedContentHash` 不同。

因此 `localChanged` 同时覆盖尚未本地保存的编辑和已经保存但尚未上传的编辑。不能只看 `dirty`。

### 9.2 四种结果

| 云端变化 | 本地变化 | 必须行为 |
| --- | --- | --- |
| 否 | 否 | 两端一致，不做写操作 |
| 否 | 是 | 保留本地内容，标记等待上传；不得自动上传 |
| 是 | 否 | 自动拉取完整模块，原子写入 IndexedDB，然后刷新页面建立新会话 |
| 是 | 是 | 原子持久化冲突；不拉取、不上传、不覆盖 |

自动拉取必须先解码、校验并计算 hash，全部成功后才能替换本地记录。刷新不能用于掩盖写入失败。

### 9.3 冲突

冲突不自动合并，可以稍后处理，并且必须跨刷新保留。冲突存在时可以继续本地编辑和本地保存，但再次上传或主动拉取前必须选择且完成一种方向：

- `local-wins`：先把用户希望保留的当前暂存内容结算并保存到本地，再以最新云端头创建一个模块级原子 commit；成功后更新同步基线并清除冲突。
- `cloud-wins`：拉取最新云端完整 payload，原子覆盖本地记录，清除 pending/conflict，并刷新页面；本地暂存和历史随旧会话一起丢弃。

两个方向都必须明确由用户触发。若解决期间远端再次变化，协调器重新读取和判断，不能根据过期冲突记录静默覆盖。

### 9.4 轮询

轮询使用一次性 timer，在上一次检查完成后再安排下一次，不能让请求重叠：

- 页面可见：`60 秒 + 0–15 秒` 随机量；
- 页面隐藏：`5 分钟 + 0–60 秒` 随机量。

`visibilitychange` 后按新档位重新安排。普通网络失败、离线、限流或 GitHub 临时故障不弹出持久错误，不改变本地状态，静默等待下一次轮询。明确的凭据失效仍按第 3 节清除凭据并返回登录页。

## 10. 错误不变量

任何失败路径都必须满足：

1. token 不出现在用户输出、日志、状态快照或持久化业务数据中。
2. 未成功提交的 IndexedDB 事务不推进 payload、本地 revision 或基线。
3. 未确认的 GitHub 提交不推进云端基线；结果不确定时保留 pending revision。
4. 保存失败不清空历史、不改变当前暂存内容，也不把 `dirty` 设为 false。
5. 上传、拉取和覆盖失败不自动选择冲突方向。
6. 所有页面 `inert`、spinner 和遮罩都在失败后解除。
7. 任何 Git 操作都不删除未知文件，不 force-update `main`。
8. 原始 GitHub 错误体只用于内部分类，不直接展示或记录。
9. 损坏或不符合定义的本地/远端 payload 必须停止在校验边界，不尝试旧格式迁移。

## 11. 测试与验收清单

测试使用 Vitest、jsdom 和 fake-indexeddb。GitHub 客户端必须注入模拟 `fetch`；自动化测试绝不访问真实 GitHub 仓库。

### 历史与状态

- 100 步上限和旧步骤淘汰正确。
- `A → B → C`、撤销到 `B`、提交 `D` 后得到 `A → B → D`。
- 保存不清空历史；保存后撤销仍有效。
- 当前内容回到本地或同步基线时，状态自动变为已保存或已同步。
- `Ctrl+Z`/`Ctrl+Y` 在输入控件内仍操作模块历史；`Ctrl+Shift+Z` 不触发重做。
- 刷新后只从 IndexedDB 当前 payload 建立一个新历史步骤。

### 本地持久化与并发

- 不同 `moduleId` 使用不同数据库，数据互不污染。
- payload 和全部系统元数据在一个事务内原子写入。
- 事务失败不推进本地基线、revision 或历史状态。
- pending revision 与冲突跨刷新保留。
- 第二个同模块标签被阻止；释放 lease 后新标签可以获得锁；无 Web Locks 时禁止编辑。
- 本地保存只有静默 `inert`，云端操作显示模糊全页遮罩和 spinner；异常后两者都恢复。

### 登录与安全

- 成功登录严格按顺序验证身份、用户名、私有仓库、权限和 `main` 分支后才持久化。
- 任一验证失败都不留下半写入凭据；已保存凭据可长期恢复。
- 明确凭据失效会清除凭据并返回登录页；普通网络错误不会。
- token 不出现在 DOM 错误、console、URL、IndexedDB、历史或测试快照中。
- 首页 CSP 只允许本站脚本和 GitHub API 连接。

### GitHub 原子提交

- 一个模块的一次上传只生成一个 commit。
- 未知文件保留；只有旧 `managedFiles` 与新集合的差集被删除。
- 同模块 revision 变化产生冲突，不自动覆盖。
- 只有其他模块推进分支时自动重建并重试，最多三次。
- commit 成功但响应丢失时，通过唯一的 pending revision 幂等确认，不重复 commit。

### 同步

- 同步矩阵四种组合分别得到一致、等待上传、自动拉取和持久冲突。
- 自动拉取只在本地完全未变时发生，并在成功写入后刷新。
- 冲突的 `local-wins` 与 `cloud-wins` 都经过显式选择且能正确更新基线。
- 轮询按前台/后台区间调度、不重叠，普通网络失败静默等待下一轮。

### 工程验收

- `npm test` 可独立运行，部署工作流在构建前运行测试。
- `npm run build` 成功，构建产物只包含根首页，不包含旧模块页面或资源。
- 源码和构建入口中不存在旧 Mind Map、碎片想法或旧 `shared/privateData` 引用。
- 仓库没有新增 `AGENTS.md`，测试和构建没有访问或修改真实 GitHub 数据。
