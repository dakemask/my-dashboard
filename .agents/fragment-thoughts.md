# 碎片想法

## 1. 目的与范围

碎片想法用于快速记录多行纯文本，并保留每条想法历次修改的完整正文。列表、搜索和历史面板共同作用于同一份想法集合；整个集合共用一个本地保存和云端同步边界。

本模块提供：

- 新增、编辑和删除想法；
- 查看每条想法从创建到当前内容的完整版本历史；
- 同时搜索当前内容和旧版本内容；
- 当前页面会话内的撤销、重做；
- 自动保存到本机，以及用户明确触发的上传、拉取和冲突覆盖。

本模块不提供富文本、标签、分类、置顶、归档、历史版本恢复、自动合并或自动上传。正文没有模块人为设置的长度上限，页面也不截断正文；数据规模仍受浏览器、本机存储和远端仓库的实际能力限制。

当前格式作为外部 schema v1 接入 Shared 版本管理；尚无低于 v1 的应用内迁移逻辑。

## 2. 业务数据与规则

### Payload

完整 payload 为：

```ts
interface FragmentThoughtsPayload {
  readonly thoughts: readonly FragmentThought[];
}

interface FragmentThought {
  readonly id: string;
  readonly versions: readonly FragmentThoughtVersion[];
  readonly collapsedVersionIds: readonly string[];
}

interface FragmentThoughtVersion {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
}
```

- 当前业务格式版本为 v1。版本号由 Shared 保存在本地 IndexedDB envelope 和云端
  `revision.json.schemaVersion`，不进入业务 payload、event、content key 或
  `thoughts.json`。
- thought ID 和 version ID 均为 UUID，规范化为小写；两类 ID 共用整个 payload 的唯一性空间，任何实体之间都不能重号。
- 每条想法至少有一个版本；`versions` 按旧到新排列，最后一项就是列表显示的当前正文和最后修改时间。
- `collapsedVersionIds` 保存该想法中处于折叠状态的历史版本，只能引用自身已有版本、不得重复，并按 `versions` 的旧到新顺序规范化。
- `createdAt` 是该版本完成提交时的 UTC ISO 时间。同一想法各版本时间必须严格递增；首版时间同时代表想法创建时间。
- 正文是多行纯文本，换行统一为 LF。全空白正文无效；除换行规范化外，用户输入的其他空格原样保留。
- 不同想法可以拥有相同正文；同一条想法的编辑器检测到正文没有实际变化时不会创建新版本。
- payload 只接受定义中的字段；缺失或多余字段、空版本数组、非法或重复 ID、非法时间、非递增时间和全空白正文均无效。校验时会把 CRLF 或 CR 换行规范化为 LF。

缺失 schemaVersion 时启动停止，不自动解释为 v1。首次接入由用户手动在云端
`revision.json` 标记 v1、从 `thoughts.json` 删除旧的 payload 内版本字段，并清理
各设备旧本地数据。

payload 中 `thoughts` 的输入顺序不属于业务语义，校验后按 thought ID 规范排序；页面始终依据每条想法末版的时间倒序展示。版本折叠状态进入 payload 并参与本地保存与云端同步；搜索词、草稿、焦点和历史面板选择仍是当前标签页的实时状态，不进入 payload。

## 3. 用户操作与交互

### 页面结构

页面包含返回首页入口、标题、同步状态区、新增输入框、搜索框和想法列表。桌面宽度下，选中历史后在列表右侧显示历史栏；窄屏下使用覆盖页面的全屏历史抽屉。

想法卡片完整显示当前正文和最后修改时间，不截断正文，也不给正文设置内部滚动区。列表按最后修改时间倒序；编辑完成后，该想法随新时间移动到顶部。

界面图标使用字节跳动 IconPark 的 `@icon-park/svg`，由 Vite 在构建时打包进页面；模块不依赖运行时图标 CDN。

### 新增、编辑和删除

- 新增区使用多行纯文本输入框和明确的“保存想法”按钮。保存有效正文会创建包含一个版本的新想法，随即自动保存到本机；成功提交后清空输入并重新聚焦输入框。
- 新增输入有内容时显示“清空”。清空前必须确认；全空白内容不能保存。
- 编辑在对应卡片内原地进行，编辑期间只提供“保存修改”和“取消”。正文未实际变化时退出编辑但不创建版本；有效变化会追加新版本并自动保存到本机。
- 取消已经修改的编辑草稿前必须确认。
- 删除前必须二次确认；确认后整条想法连同全部版本一并删除并自动保存到本机。

同一时刻只允许一份业务草稿：新增输入或某张卡片的编辑输入。存在草稿时，其他新增、编辑、删除、同步、撤销和重做命令均不可执行，页面提示用户先保存、清空或取消；搜索和只读历史仍可使用。

### 撤销与重做

模块只提供 `Ctrl+Z` 和 `Ctrl+Y` 两个业务快捷键，不提供撤销/重做按钮或其他提交快捷键。

- 焦点位于输入控件时，快捷键保留浏览器原生文字撤销和重做行为。
- 焦点不在可编辑控件且没有草稿时，`Ctrl+Z` 撤销最近一步已完成业务动作，`Ctrl+Y` 重做。
- 新增、编辑、删除、版本折叠/展开及它们的撤销、重做完成后都立即尝试自动保存到本机。
- 撤销编辑会移除刚追加的末版；重做恢复同一个版本对象。撤销删除会完整恢复该想法及全部版本。

### 搜索

搜索随输入即时筛选，以不区分大小写的纯文本子串同时匹配每条想法的当前正文和全部旧版本：

- 当前正文命中时，在卡片正文中安全高亮匹配文字；
- 只有旧版本命中时，仍显示该想法的当前卡片，并显示“历史命中 N 版”；
- 点击历史命中提示会打开该想法的历史栏，并突出命中的版本和匹配文字；
- 没有任何匹配时显示明确的无结果状态。

正文和搜索高亮通过文本节点呈现，正文中的 HTML 字符不作为页面标记解释。

### 历史面板

历史正文只读，并按旧到新展示选中想法的全部版本。新建想法的版本默认展开；之后可独立折叠每个版本，折叠状态立即保存到本机并可由用户手动上传至云端。版本标题只显示修改时间，不显示版本号或“当前”标记。

再次点击当前想法的“历史”按钮或面板关闭按钮会收起历史；点击另一条想法的“历史”会直接切换内容。搜索造成的历史命中会在面板中突出对应版本。

折叠或展开是可逆业务动作，会占用一次 100 步会话历史并可通过 `Ctrl+Z` / `Ctrl+Y` 撤销或重做。存在新增或编辑草稿时，折叠操作同其他数据修改一样受草稿门禁限制；搜索命中的折叠版本会临时展开且暂时不可切换，以显示匹配内容但不改写其持久化折叠状态。

### 本地保存与同步

- 每个已完成的业务动作（包括折叠或展开历史版本）都立即调用本地保存；没有常驻的手动保存命令。
- 自动保存失败时保留当前暂存 payload 和历史，显示持续的“未保存”状态及“重试保存”按钮。
- 页面有有效草稿或尚未保存到本机的数据时，关闭或离开页面会提示用户；已保存但未上传本身不触发该提示。
- 上传和拉取始终由用户明确触发。上传表示以本地完整数据为准，拉取表示以云端完整数据为准，不进行逐条或逐版本自动合并。
- 没有账户时模块以本地模式运行，只显示本机保存状态，不显示上传、拉取或云端版本；添加账户和选择账户统一在首页设置中完成。
- 本地和云端双方均有变化或已经形成冲突时，覆盖前必须显示清楚的方向性确认：上传选择本地覆盖云端，拉取选择云端覆盖本地。
- 状态区区分本地保存时间、已知云端更新时间、页面未保存、本地尚未上传、上传结果待确认和冲突，不能把“已保存但未上传”显示成“页面未保存”。
- 上传、拉取、版本状态、覆盖确认和同步结果由 Shared `ModuleSyncUi` 统一呈现；模块不维护第二套同步按钮、状态文案或冲突确认。
- 本模块向 Shared 提供草稿门禁：存在新增或编辑草稿时返回 `blocked`，由公共 UI 显示门禁说明并停止手动上传或拉取。自动保存、保存失败提示和“重试保存”仍由本模块负责。

后台远端变化恰好发生在草稿期间时属于草稿门禁的唯一例外：有效的非空新增或编辑草稿先结算为一个业务 event，使本地变化能够进入冲突判断；全空白草稿直接取消。该规则只防止远端观察打断草稿，不代表自动解决冲突。

## 4. 代码结构与状态归属

| 文件 | 职责 |
| --- | --- |
| `modules/fragment-thoughts/index.html` | 页面入口、严格 CSP 和 Shared 公共操作样式链接 |
| `src/fragment-thoughts/main.ts` | 创建 controller 和 hooks、启动 runtime，并处理非 ready 状态和安全启动失败 |
| `src/fragment-thoughts/definition.ts` | 唯一的模块定义、历史容量和 codec 接线 |
| `src/fragment-thoughts/domain/types.ts` | payload、实体和 event 类型 |
| `src/fragment-thoughts/domain/model.ts` | 空 payload、正文规范化、ID/时间规则和完整校验 |
| `src/fragment-thoughts/domain/events.ts` | 五类 event 的纯 `apply` / `invert` |
| `src/fragment-thoughts/domain/codec.ts` | payload 与 `thoughts.json` 的严格映射 |
| `src/fragment-thoughts/domain/index.ts` | 领域层公共导出 |
| `src/fragment-thoughts/app/controller.ts` | 唯一 runtime 持有者；协调草稿、投影、历史、搜索、自动保存，并向 Shared 同步 UI 提供门禁 |
| `src/fragment-thoughts/ui/shell.ts` | 安全 DOM 壳、同步 UI 挂载点、卡片/编辑器、历史栏、业务确认对话框和 toast |
| `src/fragment-thoughts/style.css` | 页面布局、状态和桌面/窄屏响应式样式 |

- Shared runtime 持有当前完整 payload、业务 event 历史和保存同步 snapshot。
- controller 持有 runtime 引用及当前标签页的搜索词、草稿和历史选择；折叠状态由 payload 持有，DOM 只是这些状态和 payload 的投影。
- 领域层不访问 DOM、存储、网络、当前时间或随机数；新 ID 和新时间由 controller 在构造 event 时给出。
- `main.ts` 在启动 runtime 前先建立完整 hooks；ready 后才把 runtime 交给 controller。其他启动状态由公共边界呈现并释放 controller；捕获异常只显示安全、可重试的模块文案。

## 5. 本模块的持久化定义

### 模块与历史

- `moduleId` 固定为 `fragment-thoughts`。
- 使用 JSON 兼容的完整 payload，历史容量固定为 100 步。
- 一次新增、一回有效编辑、一次确认删除或一次版本折叠/展开各占一个历史步骤；输入过程、搜索、历史面板开合和焦点变化不进入历史。

五类 event 为：

| Event | 用途 | 主要约束与 inverse |
| --- | --- | --- |
| `insert-thought { thought }` | 新增想法或撤销删除 | thought 必须完整合法且 ID 不重复；inverse 为按 ID 删除 |
| `delete-thought { thoughtId }` | 删除想法或撤销新增 | ID 必须存在；inverse 从 before 恢复完整 thought |
| `append-version { thoughtId, version, collapsed }` | 完成一次有效编辑或重做编辑 | thought 必须存在，新 version ID 唯一且时间晚于现有末版；`collapsed` 精确恢复版本折叠状态；inverse 移除该末版 |
| `remove-last-version { thoughtId, versionId }` | 撤销一次编辑 | 只能移除指定的当前末版，且不能移除唯一版本；inverse 从 before 重新追加完整 version |
| `set-version-collapsed { thoughtId, versionId, collapsed }` | 折叠或展开一个历史版本 | thought 与 version 必须存在；inverse 从 before 恢复原折叠值 |

`apply`、`invert` 和校验都不修改输入对象。语义上无变化的动作由 controller 在 dispatch 前过滤。

### settle 与 project

用户触发的保存重试、撤销和重做在 controller 层先经过草稿门禁；上传和拉取经过模块提供给 `ModuleSyncUi` 的同一业务门禁。因此这些命令开始时不存在未处理业务草稿。

`settle("remote-change")` 使用特殊的数据安全规则：有效非空草稿返回一个 `insert-thought` 或 `append-version` event，全空白草稿取消。其他公共命令已由 controller 的草稿门禁保证没有待处理草稿，因此其他 settle reason 返回 `null`。

`project(payload, reason)` 始终以传入的完整 payload 重新投影页面：

- initialize 建立初始列表；
- undo/redo 清理已经不存在的编辑对象或历史选择，再呈现新的完整数据；
- 搜索词可以跨投影保留并重新应用；
- 版本折叠状态从 payload 恢复；草稿、焦点和历史面板选择等实时状态不从 payload 恢复。

### 远端 codec

模块远端根目录为 `data/fragment-thoughts/`，只管理一个 `thoughts.json`：

- 文件内容是完整 `FragmentThoughtsPayload`，使用两个空格缩进并以换行结尾；
- 相同 payload 必须得到逐字节相同的文件内容；
- decode 只接受恰好一个名为 `thoughts.json` 的受管文件并解析原始 JSON；
- 缺失文件、额外文件或损坏 JSON 由 codec 拒绝；Runtime 根据 schemaVersion 完成迁移后再执行完整 payload 校验；
- codec 不读取或生成 Shared 的系统文件。

模块自动测试只覆盖领域层和 codec：空数据、payload 与折叠引用不变量、五类 event 的 apply/invert 与输入不可变，以及 codec 的稳定编码、往返和非法输入。UI、搜索、保存重试和同步交互由用户依据交付时的验收清单验收。
