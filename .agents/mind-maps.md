# Mind Map

## 1. 目的与范围

### 解决的问题

Mind Map 让用户在一个资料库中管理多张脑图，并在自由画布上用文本节点和有向箭头组织想法。资料库、全部脑图和它们的历史、保存与同步共同构成一个模块，而不是彼此独立的小文件编辑器。

### 主要能力

- 用无限层级文件夹创建、重命名、移动和删除脑图；
- 在 SVG 自由画布中创建、编辑、移动和 resize 文本节点；
- 在节点四边中点之间建立简单有向箭头；
- 跨文件夹和脑图撤销、重做同一条资料库历史；
- 保存到本机、上传、拉取，并在冲突时明确选择本地或云端完整资料库；
- 在当前设备恢复侧栏开关、最近脑图和文件夹展开偏好。

### 明确边界

本模块不提供：

- 复制粘贴画布对象、搜索、节点样式、富文本或自动布局；
- 箭头文字、曲线、样式或创建后的端点修改；
- 触控专用编辑；

模块当前没有分页、虚拟化或业务数据量上限，不声明额外的大规模性能保证。

## 2. 业务数据与规则

### 核心实体与关系

- **资料库**：模块的完整业务边界，包含所有文件夹和脑图。
- **文件夹**：没有单独对象或 ID，以规范化逻辑路径表示；根目录不是 `folders` 中的空字符串。
- **脑图**：`MindMapDocument`，属于根目录或一个现存文件夹，具有全资料库稳定 ID、逻辑路径、节点和箭头。
- **节点**：`MindMapNode`，属于一张脑图，包含稳定 ID、多行纯文本、frame 和自动宽度状态。
- **箭头**：`MindMapArrow`，属于一张脑图，以稳定 ID 和两个 endpoint 引用节点四边中点。

文件夹和脑图是不同类型，因此可以在同一父目录使用相同显示名称。判断脑图是否属于文件夹必须比较 `parentPath(map.path)`；脑图路径与文件夹路径相同表示二者是同级项目，不表示脑图位于该文件夹内。

### 身份、名称、路径与顺序

- map ID 在整个资料库唯一；node/arrow ID 在各自脑图中唯一。重命名和移动只改变路径，不改变 ID。
- `folders` 显式包含全部祖先文件夹。脑图 path 包含显示名称，但不含 `.json`。
- 名称提交前 trim 并做 Unicode NFC。空字符串、`.`、`..`、斜杠、反斜杠和控制字符无效。
- 文件夹名称不得以 `.json` 结尾。脑图名称末尾一个或多个 `.json` 后缀会被移除，UI 始终显示无后缀名称。
- 同一父目录、同一类型按 Unicode 不区分大小写判重；不同类型可以同名。
- 根目录脑图不能显示为 `revision`，避免与 Shared 的 `revision.json` 冲突。
- 每层先显示文件夹，再显示脑图；同类型使用 `zh-CN`、数字感知、不区分大小写的顺序，collator 相等时再以码点顺序确定结果。
- 重命名或移动先验证完整目标子树；任一名称或路径冲突都使整个动作失败。

### 必须始终成立的业务不变量

- payload 对象只有定义字段；所有几何数值有限，width/height 为正数。
- 每个箭头的两端节点必须存在于同一脑图，且不能自连。
- `from.nodeId/from.side/to.nodeId/to.side` 完全相同的有向连接只能存在一次。
- 删除节点时，同一业务动作同时删除全部相连箭头；一次撤销完整恢复。
- 文件夹不能移动到自身或任何后代。
- 删除或移动文件夹只影响真正位于其子树中的脑图，不影响与文件夹同路径的同级脑图。
- folders、maps、nodes 和 arrows 始终使用领域层定义的规范稳定顺序。

### 不进入业务数据的状态

- 当前脑图、资料库选择、画布选择、焦点、悬停、草稿、pointer、拖放、移动、resize、框选、连线和平移属于页面实时状态。
- 每张脑图 viewport 只在当前页面会话中按 map ID 记忆。
- 侧栏开关、最近脑图和展开文件夹是尽力而为的本机 UI 偏好。
- event 历史、revision、版本时间、pending 和 conflict 是 SDK/系统状态，不是 Mind Map 业务实体。

### 格式边界

payload 多余或缺失字段、非法路径、重复 ID、无效几何、缺失箭头节点、非法受管文件或损坏 JSON 均被拒绝。

## 3. 用户操作与交互

### 页面和主要区域

页面使用浅色主题，由顶栏、左侧固定宽度浮动资料库、SVG 自由画布、版本区域、toast 和确认对话框组成。资料库浮在画布上方，不改变画布业务坐标。

顶栏只读显示当前脑图名称，并提供：首页、资料库开关、保存、上传、拉取、添加文本、添加箭头和复位。没有当前脑图时禁用添加文本、添加箭头和复位。

资料库首次默认打开，之后按本机偏好恢复；打开脑图不关闭资料库。

空资料库显示创建提示。没有当前脑图时隐藏业务画布、显示空状态并禁用画布命令；空脑图复位使用默认 viewport。最近脑图已不存在时清除偏好，不自动挑选另一张图。

### 资料库

- 文件夹可无限嵌套并直接包含文件夹和脑图。
- 单击文件夹同时选中并切换折叠；单击脑图同时选中并打开。资料库选择与画布选择互相清除。
- 新建以当前选中文件夹为父目录；选中脑图时使用其父目录；没有适用选择时使用根目录。
- 新建、移动或历史定位会展开显示目标所需的祖先；恢复最近脑图严格保留原展开集合，不额外展开。
- 顶部操作只有新建文件夹、新建脑图、重命名和删除。
- 名称使用行内编辑。Enter 或 blur 在校验成功时提交；明确的取消按钮丢弃草稿。普通无效提交保留编辑器并显示错误；SDK settle 到来时无效草稿被取消。
- 项目只通过 HTML 拖放移动到现存文件夹或根目录；悬停折叠文件夹约 650 ms 自动展开。文件夹不能放入自身或后代。
- 删除脑图必须确认；删除文件夹必须明确提示递归删除所有后代后再确认。
- Delete 在资料库上下文打开同一删除确认，不直接删除。
- 相对本地保存基线有变化时，受影响脑图和现存祖先文件夹显示 `*`；成功本地保存后消失。

资料库名称只在有效 Enter/blur 时完成；拖放只在合法 drop 时完成；删除只在用户确认后完成。折叠、展开、选择、悬停和拖放中间过程不属于业务动作。

### 画布、viewport 与选择

- 画布用 SVG 属性更新几何和 transform，不生成动态内联 style；页面保持严格 CSP。
- 滚轮以鼠标为中心缩放，范围固定为 0.25–2.5。
- 空白处右键拖动平移；画布禁用原生右键菜单，编辑 textarea 保留原生菜单。
- 第一次打开脑图和“复位”适配全部节点，并避开打开的资料库；空脑图使用默认 viewport。
- 空白左拖框选；只有节点 frame 或整条箭头线段被矩形完整包含才命中。普通框选替换选择，Ctrl+框选切换框内对象。
- 普通单击替换选择；Ctrl+单击切换对象。
- 拖动未选中节点先替换原选择；Ctrl+拖动未选中节点把它加入选择并移动整组；拖动已选节点移动整组。
- 选中节点临时提高绘制层级；编辑、实际移动或 resize 的节点位于最高层。
- moving、resizing、marquee 和 connecting 接近可见区边缘时自动平移；viewport 改变后仍以世界坐标继续交互。结束、取消或 settle 停止动画。

viewport、平移、缩放、框选过程和纯选择变化不进入业务历史。

### 节点与文字

节点只有多行纯文本与 frame。初始 frame 为 260×92，`autoWidth` 为 false；最小宽高为 32×35。

首次把默认空节点编辑为非空文本时，宽度采用文字自然宽度并限制在最小宽度至 260 之间，保持固定宽度模式。`autoWidth` 已为 true 时，后续文字编辑跟随自然宽度。文字高度始终至少满足内容和最小高度。

手工 resize 完成时：请求宽度大于文字自然宽度则收紧到自然宽度并设 `autoWidth: true`；否则保存请求宽度、允许换行并设为固定宽度。文字和 resize 的最终布局值都必须由实时层在 event 中给出，领域 apply 不读取 DOM 测量。

节点只有四种视觉状态：

| 状态 | 含义 |
| --- | --- |
| `idle` | 未选中、未操作 |
| `moving` | 已选中待移动或正在移动 |
| `resizing` | 正在拖动右下 resize 手柄 |
| `editing` | textarea 正在编辑 |

只提供右下手柄。单选或编辑时显示；多选或混合选择不显示。普通左键在文字内部按下时直接进入编辑：单击保留实际落点的光标，按住拖动直接选择文字，松开后不重置光标或选区。节点边框周围仍用于拖动节点。blur/点击别处提交，Enter 只换行。编辑中按下边框或手柄时先提交文字，再开始移动或 resize。

节点移动和 resize 只在 pointerup 提交最终 event；pointercancel 或 settle 取消中间几何并恢复已提交 payload 的投影。

### 箭头

箭头是节点四边中点之间的简单有向直线，没有文字、曲线、样式或端点后改。

添加箭头是单次模式：

1. 进入时提交输入、取消其他实时交互、清空选择并显示全部连接点；
2. 从一个连接点拖到另一个节点的连接点；
3. 合法释放提交一个箭头 event，随后退出且不选择新箭头；
4. 自连、重复或未命中目标的释放不提交 event，但仍退出；
5. 点击空白或再次点击箭头按钮也退出。

### 保存、同步、版本和返回首页

- 保存按钮表示只写本机；上传按钮表示把当前本机版本同步到云端。
- 已有冲突时，点击上传确认 `local-wins`，点击拉取确认 `cloud-wins`；取消则保留冲突。
- 本地存在未保存或未上传变化时，拉取先确认“云端覆盖本地”，确认后直接执行 cloud-wins。
- 冲突只通过版本区域变色和说明呈现，不显示阻塞横幅。
- 本地版本始终显示 `localSavedAt` 或“时间未知”；页面有未保存修改时在版本旁追加状态。
- 云端显示 `knownRemoteUpdatedAt`；只有 revision 时显示“时间未知”，二者均无时显示“尚无版本”。pending、本地领先、同步一致和冲突使用不同非阻塞状态。
- 已保存但未上传必须显示为独立状态，不能误标为页面未保存。

返回首页前先结算有效文字/名称草稿。`sessionDirty` 为 true 时提供“保存并返回 / 不保存返回 / 取消”；保存成功后再导航。已保存但未上传时直接返回。`beforeunload` 只在尚未保存到本机时提示：runtime dirty，或仍存在有效未提交文字/名称变化；同步领先和冲突本身不触发提示。

### 快捷键

| 键位 | 行为 |
| --- | --- |
| 精确 `Ctrl+Z` | `runtime.undo()` |
| 精确 `Ctrl+Y` | `runtime.redo()` |
| 精确 `Ctrl+S` | `runtime.save()` |
| `Ctrl+Shift+Z` | preventDefault，完全无动作 |
| `Alt+1` | 先结算输入，在可见画布中心新增文本节点 |
| `Alt+2` | 先结算输入，进入单次添加箭头模式 |
| `Delete` | 文字输入中删除文字；画布上下文删除选择；资料库上下文打开删除确认 |

“精确 Ctrl”表示 Ctrl 按下且 Shift/Alt/Meta 均未按下。Ctrl 历史/保存命令和 Alt+1/2 即使焦点在输入控件也执行模块命令。输入法 composition 期间不得误提交 Enter。

Backspace、Ctrl+A 和 Escape 不是模块命令；在输入控件中保留文字行为，在画布不承担删除、全选或隐藏取消。Enter 只服务名称提交或 textarea 换行。

## 4. 代码结构与状态归属

### 主要组件和源码入口

| 文件 | 职责 |
| --- | --- |
| `modules/mind-map/index.html` | 页面入口、严格 CSP 和 Shared 公共遮罩样式链接 |
| `src/mind-map/main.ts` | 创建页面控制器并启动 runtime；处理启动边界 |
| `src/mind-map/definition.ts` | 唯一 `ModuleDefinition` |
| `src/mind-map/domain/types.ts` | payload、entity 和 event 类型 |
| `src/mind-map/domain/model.ts` | 完整校验与规范排序 |
| `src/mind-map/domain/names.ts` | 名称、路径、归属辅助和显示排序 |
| `src/mind-map/domain/events.ts` | event apply/invert |
| `src/mind-map/domain/codec.ts` | payload 与远端受管文件映射 |
| `src/mind-map/app/controller.ts` | 唯一 runtime 持有者；协调业务命令、投影和保存同步 UI |
| `src/mind-map/app/payloadDiff.ts` | dirty 资料库标记和跨图历史焦点 |
| `src/mind-map/app/preferences.ts` | 侧栏、最近 map 和展开文件夹偏好 |
| `src/mind-map/canvas/MindMapCanvas.ts` | SVG 投影与画布实时状态机 |
| `src/mind-map/canvas/geometry.ts` | 纯几何与命中计算 |
| `src/mind-map/canvas/viewport.ts` | viewport 转换、缩放和适配 |
| `src/mind-map/canvas/autoPan.ts` | 四类交互共用的自动平移 |
| `src/mind-map/library/treeView.ts` | 资料库 DOM、名称草稿、折叠和拖放 |
| `src/mind-map/ui/shell.ts` | 页面壳、顶栏、版本、toast 和确认对话框 |

### 状态所有者

- Shared runtime 持有当前 payload、event 历史和保存同步系统状态。
- controller 持有页面使用的 payload 投影、本地保存基线、当前 map、资料库选择和 snapshot；它是唯一持有 runtime 的业务对象。
- canvas 持有画布选择、编辑、pointer、viewport、自动平移和临时 frame override。
- tree 持有名称草稿、折叠交互和 HTML 拖放状态。
- preferences 持有三类本机 UI 偏好。
- DOM/SVG 只是投影，不能成为业务数据真源。

### 数据流和依赖边界

```text
Canvas / Tree 用户命令
→ Controller 构造 MindMapEvent
→ runtime.dispatch(event)
→ 返回新的完整 MindMapPayload
→ Controller 投影到 Tree / Canvas / Shell
```

- `main.ts` 和 `definition.ts` 负责 Shared 接线；controller 只通过公开 `ModuleRuntime` 使用 Shared。
- canvas、tree 和纯领域文件不得导入 Shared、访问存储或网络、直接修改 payload。
- apply/invert、名称、校验、codec 和几何函数不得读取 DOM、时间、随机数或可变全局状态。
- snapshot 只变化版本时间或 pending/conflict 时，只更新 shell 状态，不重建资料库或画布，以免中断 IME 和实时 pointer。

## 5. 本模块的持久化定义

### moduleId 和持久化边界

本模块的 `moduleId` 为 `mind-maps`。整个资料库使用一个 payload、一个本机保存边界、一个同步/冲突边界和一条历史；远端根为 `data/mind-maps/`。

### Event

| Event | 用户动作 | 提交时机 | 对 payload 的影响 | inverse 所需信息 |
| --- | --- | --- | --- | --- |
| `create-folder { path }` | 新建文件夹 | 有效名称提交 | 添加一个路径 | path，用 delete-folder 反向 |
| `delete-folder { path }` | 递归删除文件夹 | 用户确认 | 删除文件夹、后代文件夹及真正位于子树的脑图 | before 中完整 folders/maps 子树 |
| `restore-folder { rootPath, folders, maps }` | inverse 专用 | 撤销删除 | 完整恢复子树 | rootPath，用 delete-folder 反向 |
| `relocate-folder { fromPath, toPath }` | 重命名或拖放文件夹 | 有效名称提交或合法 drop | 原子替换文件夹及后代路径 | 原 from/to |
| `create-map { map }` | 新建脑图 | 有效名称提交 | 添加带稳定 ID 的空脑图 | map ID，用 delete-map 反向 |
| `delete-map { mapId }` | 删除脑图 | 用户确认 | 删除一张脑图 | before 中完整 map |
| `restore-map { map }` | inverse 专用 | 撤销删除 | 完整恢复脑图 | map ID，用 delete-map 反向 |
| `relocate-map { mapId, path }` | 重命名或拖放脑图 | 有效名称提交或合法 drop | 替换逻辑路径，ID 不变 | before 中旧 path |
| `add-node { mapId, node }` | 添加文本节点 | 按钮/Alt+1 命令完成 | 添加节点 | node ID，用 delete-objects 反向 |
| `set-node-text { mapId, nodeId, text, frame, autoWidth }` | 提交文字 | blur、点击别处或 settle | 同时保存文字和最终布局 | before 中 text/frame/autoWidth |
| `set-node-frame { mapId, nodeId, frame, autoWidth }` | resize 节点 | pointerup | 保存最终 frame/autoWidth | before 中 frame/autoWidth |
| `move-nodes { mapId, positions }` | 移动单个或多个节点 | pointerup | 批量替换最终位置 | before 中各节点旧位置 |
| `add-arrow { mapId, arrow }` | 添加箭头 | 合法 endpoint 释放 | 添加一条有向连接 | arrow ID，用 delete-objects 反向 |
| `delete-objects { mapId, nodeIds, arrowIds }` | 删除画布混合选择 | Delete 命令完成 | 删除对象，并自动删除被删节点相连箭头 | before/after 差异中的完整 nodes/arrows |
| `restore-objects { mapId, nodes, arrows }` | inverse 专用 | 撤销删除 | 完整恢复节点、箭头及连接 | 对象 ID，用 delete-objects 反向 |

### 历史容量与跨图历史

- `history.capacity` 固定为 100，理由是资料库动作可能携带完整删除子树，需要限制页面会话内历史内存。
- 100 步历史限制不是 payload 大小限制。
- 整个资料库共享一条队列；切换脑图/文件夹不切换或清空历史。
- 一次资料库动作、文字提交、拖动、resize、连线或批量删除各占一步。
- pointermove、选择、框选过程、viewport、平移、侧栏和展开不进入历史。

undo/redo 完成后，controller 比较 before/after 完整 payload：画布 event 打开受影响脑图；资料库 event 选择受影响项目；恢复删除时打开恢复脑图或选择文件夹；目标消失时选择最近仍存在的父文件夹，否则清空资料库选择。投影不恢复旧画布选择、编辑或 pointer 状态。

### settle

`local-save`、`upload`、`pull`、`remote-change`、`undo` 和 `redo` 使用同一结算规则：结束名称或文字草稿，取消资料库拖放、画布 pointer、连线与自动平移，并返回至多一个 event。

精确顺序：

1. 取消资料库拖放和悬停展开 timer；
2. 有效资料库名称草稿转换为 event，无效草稿取消；
3. 没有资料库 event 时，提取有效节点文字 event；
4. 取消移动、resize、框选、连线和平移，停止自动平移并释放 pointer capture；
5. 退出箭头模式，清空资料库和画布选择；
6. 返回步骤 2 或 3 的 event，否则返回 null。

文字编辑中 undo 会先提交当前文字变化，再撤销这次变化，结果回到修改前。redo 前若提交了新的有效文字变化，旧 redo 路径不再保留。

### project

- 通用投影取消资料库和画布实时状态，替换完整 payload，清理失效偏好与选择。
- initialize 只恢复仍存在的最近 map；不存在时清除偏好，不猜测替代 map，也不为恢复动作展开祖先。
- undo/redo 的业务焦点由 runtime 命令返回后 controller 的 payload diff 逻辑决定；project 本身只负责清理和投影。
- canvas project 清除选择、编辑、pointer、箭头模式和临时 frame，但保留本页按 map ID 记录的 viewport。
- 纯 snapshot 时间/pending 变化不触发完整 project。

### 远端编码

- 每张脑图编码为 `<逻辑路径>.json`；文件内容只有 `id`、`nodes`、`arrows`，使用稳定顺序、两个空格缩进和结尾换行。
- map path 从文件相对路径恢复，不在文件内容重复。
- 没有直接子文件夹或脑图的空叶文件夹编码为空的 `<folder>/.gitkeep`。
- decode 接受合法 `.json` 和空 `.gitkeep`，从路径补齐全部祖先，再执行完整 payload 校验。
- codec 不生成 `revision.json`；远端清单和未知文件的处理由 Shared 完成。
