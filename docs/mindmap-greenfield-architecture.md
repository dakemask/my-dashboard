# Mind Map 新版模块契约

## 1. 范围与优先级

开发或维护 Mind Map 时依次阅读：

1. [通用模块约束](./general-module-constraints.md)；
2. [Shared 模块 SDK 使用指南](./shared-module-sdk-guide.md)；
3. 本文。

本文是新版 Mind Map 的业务与交互权威契约。登录、IndexedDB、编辑锁、GitHub 原子提交、轮询、公共 spinner 和同步四象限由 Shared 负责；本文只说明 Mind Map 如何定义完整资料库、如何把用户动作提交为 event，以及 UI 如何调用 runtime。

新版必须从零实现：不得复制、导入或包装旧 Mind Map 源码，不读取旧本地/云端格式，也不保留旧状态结构或迁移分支。允许保持已确认的节点默认尺寸和文字布局行为一致，但算法必须在新分层内重新实现。

固定入口与边界：

- `moduleId` 为 `mind-maps`，远端根由 Shared 派生为 `data/mind-maps/`；
- 页面入口为 `modules/mind-map/index.html`，首页入口名称为“思维导图”；
- 使用 `defineJsonModule<MindMapPayload, MindMapEvent>`；
- 整个资料库是一个 payload、一个本地保存边界、一个同步/冲突边界和一条全局历史；
- 只有应用控制器持有 `ModuleRuntime`。资料库视图和画布只发出命令/回调，不导入 Shared、不直接修改 payload。

推荐代码分层为领域模型、event 与 codec、几何与 viewport、应用控制器、SVG 画布、资料库树和页面 shell。领域与几何层保持纯函数，DOM 层不得成为业务数据真源。

## 2. 完整 payload

### 2.1 固定 JSON 形态

```ts
type ConnectorSide = "top" | "right" | "bottom" | "left";

interface MindMapEndpoint {
  nodeId: string;
  side: ConnectorSide;
}

interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  autoWidth: boolean;
}

interface MindMapArrow {
  id: string;
  from: MindMapEndpoint;
  to: MindMapEndpoint;
}

interface MindMapDocument {
  id: string;
  path: string;
  nodes: MindMapNode[];
  arrows: MindMapArrow[];
}

interface MindMapPayload {
  folders: string[];
  maps: MindMapDocument[];
}
```

`folders` 保存逻辑文件夹路径，例如 `工作/项目 A`；根目录不作为空字符串写入数组。`MindMapDocument.path` 保存包含显示名称、但不带 `.json` 后缀的逻辑路径。map、node 和 arrow 的 ID 一经创建必须稳定；重命名和移动只改变逻辑路径，不改变 ID。

校验和规范化必须保证：

- 对象只包含上述固定字段；数值有限，width/height 为正数；
- 所有父文件夹都显式存在于 `folders`；
- folder path、map path 和各图内部的 node/arrow ID 唯一；
- 同一脑图中的箭头端点引用现存节点，禁止自连；
- 完全相同的有向端点组合 `from.nodeId/from.side/to.nodeId/to.side` 只能存在一次；
- folders 按逻辑中文路径稳定排序，maps 按路径再按 ID 排序，nodes/arrows 按 ID 排序；
- 根目录脑图不能显示为 `revision`，避免与 Shared 的 `revision.json` 冲突。

### 2.2 不进入 payload 的状态

以下内容只属于当前页面会话，不得保存到 IndexedDB 或 GitHub：

- 当前脑图、资料库选择、节点/箭头选择、焦点和悬停；
- 正在输入的文字或资料库名称草稿；
- pointer ID/capture，以及移动、resize、框选、连线、平移和拖放的中间状态；
- 每张脑图的 viewport、资料库展开集合和侧栏开关；
- DOM/SVG 引用、动画帧、自动平移状态；
- event 队列、保存/同步/冲突、revision 和版本时间。

侧栏开关、最近打开的 map ID 和展开文件夹集合可以作为尽力而为的本机 UI 偏好写入 `localStorage`，但它们不属于业务 payload，也不得影响 content key。

## 3. 名称、路径与远端文件

### 3.1 名称规则

提交名称前必须 trim 并做 Unicode NFC 规范化。空名称、`.`、`..`、包含 `/`、`\` 或控制字符的名称无效。

- 文件夹名称不得以 `.json` 结尾；
- 脑图名称输入末尾可带 `.json`，提交时移除该后缀，UI 始终显示无后缀名称；
- 同一父目录、同一类型按 Unicode 不区分大小写判重；文件夹与脑图属于不同类型，因此可以同名；
- 文件夹优先显示；同类型按中文、数字感知且有确定 tie-breaker 的顺序排列；
- 任何重命名或移动都必须先验证完整目标子树/路径，失败时 payload 和历史保持原子不变。

### 3.2 codec

每张脑图编码为一个受管文件：

```text
<逻辑文件夹>/<脑图显示名称>.json
```

文件 JSON 只保存：

```ts
interface StoredMapDocument {
  id: string;
  nodes: MindMapNode[];
  arrows: MindMapArrow[];
}
```

`path` 由文件相对路径推导，不在文件内容中重复。JSON 使用稳定顺序、两个空格缩进并以换行结尾。

没有直接子脑图或子文件夹的空叶文件夹编码为空的 `<folder>/.gitkeep`；父目录由其受管后代路径隐含，decode 时必须补齐全部祖先。codec 只接收 Shared 清单列出的受管文件；仓库中的未知文件仍由 Shared 保留，Mind Map 不得接管或删除。

decode 只接受合法 `.json` 和空 `.gitkeep`，重建 path 后再走完整 payload 校验。encode/decode 必须确定、无损，并使规范 content key 往返不变。

## 4. event 与全资料库历史

### 4.1 固定事件集合

`history.capacity` 固定为 `100`，按已提交 event 数计。整个资料库共享同一条队列；切换脑图或文件夹不会切换、清空或拆分历史。

事件 discriminant 与职责固定为：

| event | 固定业务含义 |
| --- | --- |
| `create-folder { path }` | 新建一个文件夹 |
| `delete-folder { path }` | 递归删除文件夹、后代文件夹和脑图 |
| `restore-folder { rootPath, folders, maps }` | inverse 专用，完整恢复已删子树 |
| `relocate-folder { fromPath, toPath }` | 原子重命名或移动文件夹及全部后代 |
| `create-map { map }` | 新建带稳定 ID 的空脑图 |
| `delete-map { mapId }` | 删除一张脑图 |
| `restore-map { map }` | inverse 专用，完整恢复脑图 |
| `relocate-map { mapId, path }` | 原子重命名或移动脑图 |
| `add-node { mapId, node }` | 新增一个节点 |
| `set-node-text { mapId, nodeId, text, frame, autoWidth }` | 一次文字提交及其最终布局结果 |
| `set-node-frame { mapId, nodeId, frame, autoWidth }` | 一次 resize/最终 frame 提交 |
| `move-nodes { mapId, positions }` | 一次单节点或多节点移动的最终位置 |
| `add-arrow { mapId, arrow }` | 新增一条有向直线箭头 |
| `delete-objects { mapId, nodeIds, arrowIds }` | 一次混合节点/箭头批量删除 |
| `restore-objects { mapId, nodes, arrows }` | inverse 专用，恢复删除内容及连接关系 |

重命名和移动共用 relocate event，因为两者都是路径的原子替换。删除任一节点时，同一个 `delete-objects` event 必须同时移除全部相连箭头；inverse 从 before/after 差异取得实际被删节点和箭头，使一次 undo 完整恢复。

folder 与 map 可以同名，因此判断脑图是否位于文件夹子树时必须比较 `parentPath(map.path)`，不能把 `map.path === folder.path` 当成从属关系。同路径脑图是该文件夹的同级项目；删除或移动文件夹不得误操作它。

### 4.2 提交与历史规则

一次语义动作只 dispatch 一次：一次资料库操作、一次文字提交、一次拖动、多选移动、resize、连线或批量删除各自只产生一个 event。pointermove、框选本身、viewport、平移、侧栏、展开/折叠和纯选择变化不进入历史。

领域层的 apply/invert 必须：

- 校验输入和目标存在性，返回新的规范化完整 payload，不修改参数；
- 对同一输入确定，不访问 DOM、时钟、随机数、网络、存储或可变全局状态；
- forward 后应用 inverse 恢复原 content key；
- 在冲突名称、非法路径、缺失目标、重复连接等失败时不产生部分修改。

no-op、redo 分支、容量淘汰、保存基线和异常原子性遵循 Shared 通用规则。

### 4.3 跨图 undo/redo 焦点

undo/redo 前后比较完整 payload，而不是假定变化发生在当前图：

- 画布 event：自动打开受影响脑图，并在资料库中选中它；
- 资料库 event：选中新建/恢复/移动后的目标文件夹或脑图；脑图目标存在时打开它；
- 撤销删除后打开恢复的脑图或选中恢复的文件夹；
- 目标在 after payload 已不存在时，选择最近仍存在的父文件夹；没有父文件夹时清空项目选择，并把后续新建/拖放上下文视为资料库根；
- 投影后不恢复旧画布选择、编辑或 pointer 状态。

## 5. 实时状态结算与投影

### 5.1 `settle(reason)`

六种 reason 共用同一个互斥结算过程。设计上文字草稿、资料库名称草稿和 pointer/拖放动作不能同时成为两个待提交业务变化，因此一次 settle 最多返回一个 event。

固定顺序：

1. 有效的节点文字或资料库名称草稿先退出编辑并转换为一个最终 event；内容无变化则为 no-op/`null`；
2. 无效资料库名称草稿自动取消，不阻塞原命令；
3. 取消未到提交点的节点移动、resize、框选、拖线、右键平移和资料库拖放，丢弃临时几何；
4. 停止自动平移、清除悬停展开 timer，并释放已有 pointer capture；
5. 退出单次箭头模式，清空画布与资料库两侧的操作选择；
6. 返回步骤 1 的 event 或 `null`，由 Shared 先走正常 dispatch，再继续 save/upload/pull/remote-change/undo/redo。

文本编辑中执行 undo 时，Shared 会先记录结算 event 再撤销一次，因此结果回到该文字修改前。redo 前提交真实新草稿会按 Shared 规则剪掉旧 redo；no-op 不剪分支。保存失败时已提交的 event、当前 payload 和历史仍保留。

### 5.2 `project(payload, reason)`

`project` 只依据传入的完整 payload 重建资料库和当前脑图，清除已失效的 DOM 引用、草稿、选择、pointer、自动平移和临时 frame。初始化恢复上次仍存在的脑图；不存在时不猜测旧 ID。undo/redo 再按上一节的 payload 差异选择业务目标。

`onSnapshotChange` 可能只更新版本时间、pending 或其他系统状态。payload 与本地保存基线均未变化时，只更新顶栏状态，不得重建资料库或画布 DOM，以免中断 IME、丢失尚未 settle 的文字/名称草稿或破坏实时 pointer 状态。

每张脑图的 viewport 只在当前页面内按 map ID 记忆。第一次打开及“复位”适配全部节点，并按侧栏实际可见区域避让打开的资料库面板；没有节点时使用默认 viewport。云端拉取由 Shared 原子替换本地完整 payload 并 reload，不在旧历史上直接 project 云端数据。

## 6. 资料库交互

资料库是左侧固定宽度的浮动面板，不挤压业务画布坐标。首次使用默认打开；之后按本机偏好恢复。打开脑图不关闭面板。

- 文件夹无限嵌套，可同时直接包含文件夹和脑图；每层文件夹在前、脑图在后；
- 单击文件夹同时选中它并切换折叠；单击脑图同时选中并打开它；资料库选择会清空画布选择；
- 新建文件夹/脑图以当前所选文件夹为父目录，否则使用相应项目的父目录或根目录；成功后展开显示目标所需的祖先；
- 恢复上次脑图时严格保留已记录的展开集合，不为“打开”动作额外展开祖先；
- 顶部只提供新建文件夹、新建脑图、重命名和删除；名称使用行内编辑，Enter 或 blur 提交，并始终提供明确的“取消”按钮；
- 新建、重命名、移动成功后使用规范名称和完整路径判重；folder 与 map 可以同名；
- 项目移动只通过 HTML 拖放，目标只能是已存在文件夹或资料库根。悬停折叠文件夹约 650 ms 后自动展开；禁止把文件夹移入自身/后代；
- 删除脑图必须确认；删除文件夹必须明确警告会递归删除所有后代，再确认；
- Delete 在资料库焦点/选择上下文中打开同一删除确认，不直接删除；
- 当前页面相对本地保存基线有变化时，受影响脑图及其所有现存祖先文件夹显示 `*`。文件夹增删/移动也使对应现存路径链显示 `*`；成功本地保存后星号消失。

资料库拖放、展开、草稿和选中状态都只是实时状态。拖放释放到合法目标时才 dispatch 一个 relocate event。

## 7. SVG 自由画布

### 7.1 呈现与 viewport

页面使用浅色主题和 SVG 自由画布。位置及 viewport transform 通过 SVG 属性更新；不得为交互生成动态内联 `style`，不得放宽页面严格 CSP。画布有浅色网格。

- 滚轮以鼠标所在点为锚缩放；
- 空白处右键拖动平移；画布禁用原生右键菜单，但文字编辑 textarea 保留原生菜单；
- 复位和首次打开适配全部节点，并避开打开的资料库面板；
- viewport、滚轮、平移和网格不改变 payload，也不进入历史。

### 7.2 选择、移动与自动平移

空白处左键拖动框选节点和箭头，只有 frame 或整条线段被矩形完整包含才命中。普通框选替换选择；`Ctrl+框选` 以框选结果切换基线中的对象。

- 普通单击对象替换选择；`Ctrl+单击` 切换该对象；
- 拖动未选中节点先用该节点替换原选择，再移动；
- `Ctrl+拖动` 未选中节点时把它加入已有多选并立即移动整组；已选节点拖动整组；
- 一次拖动只在 pointerup 提交所有节点最终位置；pointercancel/settle 恢复 payload 投影；
- 画布选择变化会清空资料库选择，资料库选择变化也会清空画布选择；
- 被选节点临时提高绘制层级；正在编辑、resize 或实际移动的节点最高；
- 移动、resize、框选和拖箭头接近当前可见区域边缘时启动自动平移。平移改变 viewport，同时继续以世界坐标更新当前交互；结束、取消或 settle 必须停止动画。

### 7.3 节点

节点只包含多行纯文本和 frame，不提供富文本、颜色或其他样式。默认尺寸与自动文字布局保持已确认的旧版视觉行为，但实现和数据格式完全重写：文字提交把最终 `text + frame + autoWidth` 放进一个 event；手工 resize 若把宽度限制在文字自然宽度以内，则保存固定宽度并允许换行；若把宽度拖到自然宽度以外，则收紧到自然宽度并恢复自动宽度。resize 的最终 `frame + autoWidth` 只提交一个 event。任何布局结果都必须在 event 中显式给出，apply 不得读取 DOM 测量。

节点视觉状态只有四种：

| 状态 | 含义 |
| --- | --- |
| idle | 未选中、未操作 |
| moving | 已选中待移动或正在移动 |
| resizing | 正在通过右下手柄 resize |
| editing | textarea 正在编辑 |

只提供右下 resize 手柄。单选节点时显示；多选（包括混合选择）不显示；编辑态仍显示。点击文字区域进入编辑，点击别处/blur 提交；Enter 只插入换行。编辑时按下节点边框或 resize 手柄，必须先提交文字 event，再开始移动或 resize。

删除混合选择只 dispatch 一个 `delete-objects`。删除节点自动包含所有相连箭头，撤销一次完整恢复。

### 7.4 箭头

箭头是四边中点之间的简单有向直线，只保存稳定 ID 与 from/to endpoint。没有文字、曲线、样式、端点后改或自连接；完全重复的有向端点组合无效。

“添加箭头”是单次模式：

1. 进入时先提交文字、取消其他实时交互并清空选择，显示所有节点的四个连接点；
2. 从一个连接点拖到另一个节点的连接点；接近边缘时允许自动平移；
3. 合法释放只 dispatch 一个 `add-arrow`，随后退出模式且不选择新箭头；
4. 自连、重复、未命中目标等无效释放直接退出且不 dispatch；
5. 点击空白或再次点击“箭头”按钮也退出。

## 8. 顶栏、保存同步与返回首页

顶栏只读显示当前脑图名称，并提供：首页、资料库开关、保存、上传、拉取、添加文本、添加箭头、复位。没有当前脑图时禁用三项画布命令。

- 保存只调用 `runtime.save()`，只写本机；
- 上传调用 `runtime.upload()`，由 Shared 先结算并在必要时本地保存；
- 主动拉取没有本地变化时调用 `runtime.pull()`；存在未保存或未上传的本地变化时，先确认“用云端覆盖”。确认表示本次操作最终选择 `cloud-wins`（必要时先由 pull 持久化冲突，再 resolve），取消则不调用覆盖；
- 已持久化冲突时不显示阻塞横幅。用户点上传时确认 `local-wins`，点拉取时确认 `cloud-wins`；不选择方向则保留冲突；
- 冲突覆盖整个资料库，不逐节点、逐图合并，也不允许绕过 runtime；
- 网络/保存失败显示安全、可重试的中文文案，不输出捕获异常、token 或 GitHub 响应体。

顶栏版本区域由初始 `runtime.getSnapshot()` 和 `onSnapshotChange` 驱动：

- 本地始终显示 `localSavedAt` 或“时间未知”；`sessionDirty` 时在该时间旁追加“有未保存修改”，不能用提示文字取代版本时间；
- 云端显示 `knownRemoteUpdatedAt`；仅 revision 已知时显示“时间未知”，两者未知时显示“尚无版本”；
- conflict 只通过版本区域的冲突颜色/说明提示；pending upload、本地领先和同步一致使用各自非阻塞状态；
- “已保存到本机但未上传”由 `localChangedSinceSync` 表示，不应重新标成页面未保存。

返回首页前先结算正在编辑的文字/有效名称草稿，再读取最新 snapshot：

- `sessionDirty` 为 true 时显示“保存并返回 / 不保存返回 / 取消”；
- “保存并返回”等待本地保存成功后导航；“不保存返回”丢弃本页尚未保存内容；“取消”留在页面；
- 已本地保存但尚未上传时直接返回，不额外警告；
- 刷新/关闭页面只对“尚未保存到本机”的内容注册浏览器 `beforeunload` 提醒：`sessionDirty` 为 true，或仍有尚未 dispatch 的有效文字/名称变化。同步领先或冲突本身不触发该提醒。

## 9. 模块快捷键

Shared 不注册键盘。Mind Map 在模块层绑定并在 dispose 前移除：

| 键位 | 行为 |
| --- | --- |
| 精确 `Ctrl+Z` | `runtime.undo()` |
| 精确 `Ctrl+Y` | `runtime.redo()` |
| 精确 `Ctrl+S` | `runtime.save()` |
| `Ctrl+Shift+Z` | `preventDefault()`，完全无动作 |
| `Alt+1` | 先结算输入，再在可见画布中心新增文本节点 |
| `Alt+2` | 先结算输入，再进入单次添加箭头模式 |
| `Delete` | 文字输入中由输入框删除文字；画布上下文删除选择；资料库上下文打开删除确认 |

“精确 Ctrl”表示 Ctrl 按下且 Shift/Alt/Meta 均未按下。Ctrl 历史/保存命令即使焦点在模块输入控件中也走模块 runtime，并阻止浏览器原生命令；`Alt+1/2` 同样始终生效。输入法 composition 期间不得误提交 Enter。

Backspace、Enter 编辑入口、`Ctrl+A` 和 Escape 都不是模块命令：Backspace/`Ctrl+A` 在输入控件中保留浏览器文字行为，在画布上不承担删除/全选；Enter 只服务当前名称编辑或 textarea 换行；Escape 不作为取消或退出模式的隐藏快捷键。

## 10. 明确不实现

本轮不实现：

- 旧源码复用、旧 payload/文件读取、schemaVersion 或自动迁移；
- 复制粘贴画布对象、搜索、节点样式、自动布局、富文本；
- 箭头文字、曲线、样式或端点编辑；
- 触控专用编辑；
- 当前脑图刷新按钮、退出登录或“碎片想法”模块；
- 冲突自动合并，或程序自动删除真实 `data/mind-maps/` 旧数据。

旧目录没有合法新版 `revision.json` 时，Shared 不得猜测接管。启用新版前如需清理真实旧云端数据，由用户在应用外明确处理。

## 11. 验收

### 11.1 纯领域与几何

- payload 严格校验、规范排序、名称规则、同类型判重和失败原子性；
- 每图一个 JSON、空叶文件夹 `.gitkeep`、codec 稳定往返；
- 全部 event apply/invert、复合删除恢复、跨图历史、分支/no-op 和 100 步边界；
- 坐标转换、鼠标中心缩放、侧栏避让适配、完整包含框选、连接点与四类自动平移；
- idle/moving/resizing/editing 四状态和 settle/project 的全部提交/取消转换。

### 11.2 DOM 与浏览器

- 行内创建/重命名、取消、blur/Enter、中文输入法和拖放悬停展开；
- 资料库/画布选择互斥、Ctrl 选择与移动、混合删除、pointer capture/cancel；
- 右键平移、文字原生右键菜单、单次连线和 viewport 会话记忆；
- 顶栏按钮、快捷键优先级、确认流程、版本时间、冲突颜色、dirty 星号和 UI 偏好恢复；
- 首页返回与 `beforeunload` 只按未保存到本机的内容判断；
- 严格 CSP 下无动态内联样式，测试夹具不连接 GitHub。

### 11.3 工程

- 首页和 `modules/mind-map/index.html` 均由 Vite 多页面构建；
- `npm test`、普通 `npm run build` 和 GitHub Pages base 构建通过；
- 生产产物只包含已注册的首页与 Mind Map 页面；
- 测试全部使用 fake/in-memory 边界，绝不访问或修改真实 GitHub 数据；
- 不新增 `AGENTS.md`。
