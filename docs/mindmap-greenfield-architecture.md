# Mind Map 专用设计

## 1. 阅读范围

开发 Mind Map 前依次阅读：

1. [通用模块约束](./general-module-constraints.md)；
2. [Shared 模块 SDK 使用指南](./shared-module-sdk-guide.md)；
3. 本文。

本文只规定 Mind Map 特有的 payload、event、交互结算、快捷键和投影行为。登录、IndexedDB、编辑锁、GitHub、轮询、spinner 和冲突算法都由模块 SDK 负责，Mind Map 不得自行实现。

本模块从零开发，不复用旧 Mind Map 源码、状态结构或数据格式。

## 2. 模块定义

- `moduleId` 固定为 `mind-maps`。
- 远端根由 SDK 派生为 `data/mind-maps/`。
- 使用 `defineJsonModule<MindMapPayload, MindMapEvent>`；payload 选择 JSON 兼容结构和 SDK 的规范 JSON content key。
- `validate`、`encode` 和 `decode` 的具体字段由新实现定义，但必须覆盖整个资料库。
- `history.apply` 和 `history.invert` 由 Mind Map 实现，并必须是确定、无副作用的纯函数。
- 不为旧格式兼容加入业务 `schemaVersion` 或迁移分支。

Mind Map 必须在 `history.capacity` 中显式选择正整数或 `"unlimited"`。容量按已记录的业务 event 数量计算，不按 payload 数量计算，也不存在通用的 100 步默认值。具体容量属于后续 Mind Map 产品/性能选择：实现时必须记录所选值及理由，并为边界或 unlimited 行为添加测试，不得在 Shared 中反向写死。

## 3. 完整 payload 边界

当前 payload 覆盖整个 Mind Map 资料库以及其中全部脑图，不按单张脑图建立保存或冲突边界。

payload 包含所有可持久化业务数据，例如：

- 资料库和脑图的组织结构；
- 节点及其文本、位置、尺寸和业务属性；
- 箭头、连接关系和其他持久化画布对象。

payload 不包含：

- 当前选中、悬停和焦点；
- DOM、SVG element 或 view object 引用；
- pointer ID、pointer capture；
- 正在拖拽、resize、连线的临时几何值；
- 文本编辑器的临时状态和动画中间值；
- 保存、同步、冲突和 revision 元数据。

IndexedDB 和 GitHub 始终保存/编码整个资料库的完整 payload。页面刷新后从 IndexedDB 完整 payload 建立新的空 event 历史，不恢复上一个页面的撤销队列。

## 4. MindMapEvent 边界

历史不保存每一步完整 payload，而是保存当前完整 payload 和可逆的 `MindMapEvent`。event 是已到达提交点的业务动作，例如：

- 新增或删除资料库、脑图、节点或箭头；
- 修改节点文本或业务属性；
- 一次完成的节点移动或 resize；
- 一次完成的连线创建、替换或删除；
- 一次语义完整的多选移动、粘贴或批量删除。

一次复合动作必须是一个 event，不能按每个 pointermove、每个节点或每个字段拆成大量历史步骤。event 可以携带执行和撤销需要的最小业务数据；例如删除子树的 inverse 可以由 `invert(event, before, after)` 从 `before` 中取得完整被删子树和连接关系。event 不得携带 DOM、pointer、选择状态或系统元数据。

模块通过 `runtime.dispatch(event)` 提交动作。`history.apply(payload, event)` 返回新的完整资料库 payload；`history.invert(event, before, after)` 返回能恢复 `before` 的 MindMapEvent。两者必须：

- 不修改任何传入 payload/event；
- 不访问 DOM、网络、存储、时钟、随机数或可变全局状态；
- 对相同输入产生相同输出；
- 让 forward 后再应用 inverse 恢复原 content key。

Shared 会在边界使用 `structuredClone`。如果 apply、校验、content key、invert 或 clone 失败，当前 payload、event 队列、撤销/重做位置、redo 分支和 dirty 都不得推进。

计算后 content key 未改变的 event 是 no-op：不进入历史，也不删除 redo。撤销后 dispatch 一个真实新 event 才删除旧 redo 分支。

## 5. 保存、上传、拉取与远端变化前结算

`settle("local-save")`、`settle("upload")`、`settle("pull")` 和 `settle("remote-change")` 采用同一套 Mind Map 结算原则：

1. 如果文本框正在编辑，读取当前文本，退出文本编辑，并准备一个“修改文本”业务 event；
2. 取消正在进行的拖拽、resize 和连线，丢弃尚未到提交点的中间值；
3. 让被取消的指针交互恢复到 runtime 当前 payload 的投影；
4. 清空节点、箭头和其他对象的全部选择状态；
5. 文本业务内容确有变化时返回该 event；没有业务变化时返回 `null`。

SDK 会先 dispatch 返回的 event，再继续保存、上传、拉取判断或远端变化判断。它最终保存和同步的是 runtime 计算得到的整个资料库完整 payload，不是 event，也不是单张脑图或 dirty 对象。

`pull` reason 只在主动拉取确认云端 revision 确有变化后出现；`remote-change` 来自轮询发现 revision 变化。结算出的文本 event 会使本地变为 dirty，因此此时不得自动用云端覆盖，而应按通用同步规则形成冲突。Shared 会把结算后的整个资料库 payload、hash 和 conflict 同事务保存，使刷新后仍保留本地一侧。

保存失败后，结算得到的 event、当前 payload、历史和 dirty 必须保留，用户可以再次调用同一保存命令。

## 6. 撤销结算

`settle("undo")`：

- 文本编辑中：退出编辑；如果文本确有变化，返回一个“修改文本” event。SDK 先 dispatch 它，再执行一次撤销，因此最终回到这次文本修改之前的完整资料库状态。
- 拖拽、resize 或连线中：先取消实时交互并丢弃未提交中间值，返回 `null`，然后由 SDK 撤销上一个已提交 event。
- 没有实时交互：返回 `null`，直接撤销。

撤销由 inverse MindMapEvent 计算新的完整 payload，然后调用 `project(payload, "undo")`。文本输入框不得另外执行浏览器原生文本撤销。

## 7. 重做结算

`settle("redo")`：

- 文本编辑中：退出编辑；如果文本确有变化，返回一个“修改文本” event。这个真实新 event 会删除旧 redo 分支，所以随后通常没有旧 event 可重做。
- 如果文本结算是 no-op，它不删除 redo，SDK 仍可继续重做。
- 拖拽、resize 或连线中：先取消交互并丢弃中间值，返回 `null`，再由 SDK 重做。

重做重新应用原 forward MindMapEvent，然后调用 `project(payload, "redo")`。

## 8. Mind Map 自己绑定快捷键

Shared 不安装任何快捷键。Mind Map 模块必须自己注册并在卸载时移除以下绑定：

- 精确的 `Ctrl+Z` 调用 `runtime.undo()`；
- 精确的 `Ctrl+Y` 调用 `runtime.redo()`；
- 精确的 `Ctrl+S` 调用 `runtime.save()`；
- `Ctrl+Shift+Z` 不作为重做，也不调用其他 runtime 历史方法。

这里的“精确”表示 Ctrl 为按下状态，Shift、Alt、Meta 均未按下。即使焦点位于文本输入控件，`Ctrl+Z` 和 `Ctrl+Y` 也操作整个 Mind Map 模块历史；监听器必须 `preventDefault()`，避免浏览器同时修改输入框。保存按钮与 `Ctrl+S` 必须调用同一个 `runtime.save()` 路径。

快捷键回调必须捕获 promise 失败并显示模块定义的安全文案，不得输出原始异常。Shared 只负责串行 runtime 命令，不负责键位选择、事件监听或监听器清理。

## 9. project 投影规则

`project(payload, reason)` 必须完全从给定完整 payload 重建资料库和画布表现。初始化、撤销或重做投影完成后，所有纯实时状态恢复默认：

- 没有节点、箭头或其他对象被选中；
- 没有文本框处于编辑状态；
- 没有焦点、悬停、拖拽、resize 或连线会话；
- 不保留 pointer capture、临时几何值、旧 DOM 引用或动画中间状态。

不得继续把投影前的实时对象当作数据真源。project 只接收完整 payload；event 队列和 inverse event 不进入视图投影。

## 10. 冲突 UI

冲突覆盖整个资料库，不能只解决当前打开的脑图。

`onConflict` 触发后可以暂不选择方向，用户仍可继续 dispatch 本地 event 和调用 `runtime.save()`。下一次上传或主动拉取前，UI 必须让用户显式选择：

```ts
await runtime.resolveConflict("local-wins");
await runtime.resolveConflict("cloud-wins");
```

不得自动逐节点或逐脑图合并。冲突提示的布局、文案和按钮样式留给后续 UI 设计。

## 11. 旧实现和旧数据

新版与旧代码、旧本地格式和旧云端数据完全不兼容：

- 不读取、转换或迁移旧业务数据；
- 不保留旧源码作为适配层；
- 不由程序自动删除真实 GitHub 数据；
- 用户在使用新版前自行删除 `data/mind-maps/` 中的旧远端数据。

缺少新版合法 `revision.json` 的旧目录不得被 Shared 猜测或接管。

## 12. Mind Map 模块验收

- 使用 Shared 根入口、`defineJsonModule<MindMapPayload, MindMapEvent>` 和 `startModuleRuntime`。
- 完整 payload 覆盖资料库和所有脑图；event 队列只活在当前页面。
- `history.capacity` 已显式选择并测试，未依赖通用默认值。
- 每类 MindMapEvent 的 apply/invert 可逆、纯净、不修改输入，异常保持历史原子性。
- 文本、拖拽、resize、连线和复合动作的提交点清楚；一个语义动作只 dispatch 一个 event。
- no-op 保留 redo，撤销后真实新 event 删除旧 redo。
- 六种 settle reason 均有测试；保存/同步四种 reason 会退出文本、取消指针交互并清空选择。
- `project` 会重置全部实时交互状态。
- 模块自己绑定并清理精确的 `Ctrl+Z`、`Ctrl+Y`、`Ctrl+S`；`Ctrl+Shift+Z` 不使用。
- 保存按钮和 `Ctrl+S` 调用同一个 `runtime.save()`。
- 冲突只提供整个模块的 local-wins/cloud-wins。
- 模块内没有 token、IndexedDB、GitHub client、poller、Web Lock 或 spinner 实现。
