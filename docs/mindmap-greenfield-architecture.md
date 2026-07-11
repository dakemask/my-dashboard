# Mind Map 专用设计

## 1. 阅读范围

开发 Mind Map 前依次阅读：

1. [通用模块约束](./general-module-constraints.md)；
2. [Shared 模块 SDK 使用指南](./shared-module-sdk-guide.md)；
3. 本文。

本文只规定 Mind Map 特有的 payload 边界、交互结算和投影行为。登录、IndexedDB、编辑锁、GitHub、轮询、spinner 和冲突算法都由模块 SDK 负责，Mind Map 不得自行实现。

本模块从零开发，不复用旧 Mind Map 源码、状态结构或数据格式。

## 2. 模块定义

- `moduleId` 固定为 `mind-maps`。
- 远端根由 SDK 派生为 `data/mind-maps/`。
- 使用 `defineJsonModule`；payload 选择 JSON 兼容结构和 SDK 的规范 JSON content key。
- `validate`、`encode` 和 `decode` 的具体字段由新实现定义，但必须覆盖整个资料库。
- 不为旧格式兼容加入业务 `schemaVersion` 或迁移分支。

## 3. 完整 payload 边界

一份 payload 覆盖整个 Mind Map 资料库以及其中全部脑图，不按单张脑图建立保存、历史或冲突边界。

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

每个提交给 `runtime.commit` 的值都是整个资料库的完整 payload。一次语义完整的复合动作只提交一次。

## 4. 保存和上传前结算

保存按钮和 `Ctrl+S` 必须调用同一个 `runtime.save()`。`Ctrl+S` 是 Mind Map 自己安装的模块快捷键，页面销毁时必须移除。

`settle("local-save")` 和 `settle("upload")` 按以下顺序处理：

1. 如果文本框正在编辑，把当前文本纳入一个新的完整 payload，并退出文本编辑；
2. 取消正在进行的拖拽、resize 和连线，丢弃未到提交点的中间值；
3. 让被取消的指针交互恢复到当前暂存 payload 的投影；
4. 清空节点、箭头和其他对象的全部选择状态；
5. 有新的文本业务变更时返回结算后的完整 payload，否则返回 `null`。

SDK 随后原子保存整个模块。不得拆成“当前脑图保存”和“资料库保存”，不得只保存 dirty 对象。

保存失败后，结算得到的 payload、历史和 dirty 必须保留，用户可以再次调用同一保存命令。

## 5. 撤销结算

`settle("undo")`：

- 文本编辑中：先把当前文本组成新的完整 payload 并退出编辑，然后返回该 payload；SDK 会先提交它，再执行一次撤销，所以最终回到文本提交前的完整版本。
- 拖拽、resize 或连线中：先取消交互并丢弃未提交中间值，返回 `null`，然后由 SDK 撤销。

输入框不得保留或调用浏览器原生文本撤销；SDK 的 `Ctrl+Z` 始终操作模块历史。

## 6. 重做结算

`settle("redo")`：

- 文本编辑中：先提交当前文本并退出编辑。这个新提交会删除当前 redo 分支，因此随后通常没有旧步骤可重做。
- 拖拽、resize 或连线中：先取消交互并丢弃中间值，再由 SDK 重做。

Mind Map 不支持 `Ctrl+Shift+Z`，只使用 SDK 的 `Ctrl+Y`。

## 7. project 投影规则

`project(payload, reason)` 必须完全从给定完整 payload 重建资料库和画布表现。初始化、撤销或重做投影完成后，所有纯实时状态恢复默认：

- 没有节点、箭头或其他对象被选中；
- 没有文本框处于编辑状态；
- 没有焦点、悬停、拖拽、resize 或连线会话；
- 不保留 pointer capture、临时几何值、旧 DOM 引用或动画中间状态。

不得继续把投影前的实时对象当作数据真源。

## 8. 冲突 UI

冲突覆盖整个资料库，不能只解决当前打开的脑图。

`onConflict` 触发后可以暂不选择方向，用户仍可继续本地编辑和 `runtime.save()`。下一次上传或主动拉取前，UI 必须让用户显式选择：

```ts
await runtime.resolveConflict("local-wins");
await runtime.resolveConflict("cloud-wins");
```

不得自动逐节点或逐脑图合并。冲突提示的布局、文案和按钮样式留给后续 UI 设计。

## 9. 旧实现和旧数据

新版与旧代码、旧本地格式和旧云端数据完全不兼容：

- 不读取、转换或迁移旧业务数据；
- 不保留旧源码作为适配层；
- 不由程序自动删除真实 GitHub 数据；
- 用户在使用新版前自行删除 `data/mind-maps/` 中的旧远端数据。

缺少新版合法 `revision.json` 的旧目录不得被 Shared 猜测或接管。

## 10. Mind Map 模块验收

- 使用 Shared 根入口、`defineJsonModule` 和 `startModuleRuntime`。
- 完整 payload 覆盖资料库和所有脑图。
- 文本、拖拽、resize、连线的提交点各自清楚。
- 保存、上传、撤销、重做四种 settle reason 均有测试。
- `project` 会重置全部实时交互状态。
- 保存按钮和 `Ctrl+S` 调用同一个 `runtime.save()`。
- 冲突只提供整个模块的 local-wins/cloud-wins。
- 模块内没有 token、IndexedDB、GitHub client、poller、Web Lock 或 spinner 实现。
