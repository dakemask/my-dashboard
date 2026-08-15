# 碎片想法持久化决定

## 何时阅读

修改碎片想法的 payload、版本实体、event、历史、definition、codec、schema、草稿结算、`settle` 或 `project` 时阅读，并同时阅读 [公共持久化契约](../../contracts/persistent-module.md)。

用户可见的编辑、搜索和历史规则见 [product.md](./product.md)。

## 模块边界

- `moduleId` 固定为 `fragment-thoughts`，对应既有本地隔离键和 `data/fragment-thoughts/` 远端目录。
- 完整 payload 是全部想法；每条想法包含稳定身份、按时间排列的完整正文版本，以及已折叠版本身份集合。
- 想法在 payload 中使用规范稳定顺序，页面展示顺序由每条想法末版时间计算，不能把 UI 排序误当成存储语义。
- 搜索词、草稿、焦点、当前历史选择、面板开合和临时搜索展开不进入 payload。
- schemaVersion、revision、保存时间、pending、conflict 和会话 event 历史由 Shared 管理。

[技术占位：记录 definition、payload 类型和 validator 的稳定源码入口；不复制完整 interface。]

## 版本与折叠数据不变量

- 每条想法至少有一个版本，末版就是当前正文。
- thought ID 与 version ID 在整个 payload 的共同身份空间内唯一。
- 每条想法的版本时间严格递增。
- 折叠身份只能引用同一想法中存在的版本，不重复，并按版本顺序规范化。
- 文本换行校验后统一，空白正文拒绝；损坏、缺字段或多余字段的 payload 不自动猜测修复。
- 折叠状态参与 content key、保存和云端同步；搜索造成的临时展开不参与。

[技术占位：分别记录正文规范化、ID/时间校验和规范排序函数的源码入口；具体正则或遍历代码留在实现中。]

## Event 与历史

event 的概念粒度为：

- 插入或删除一条完整想法；
- 为现有想法追加完整版本，或撤销时移除指定末版；
- 设置某个现有版本的折叠状态。

一次新增、一次有效编辑、一次确认删除或一次折叠切换各占一步。inverse 必须携带恢复所需的完整 thought/version，而不能依赖已经变化的 DOM 或当前搜索投影。

历史容量保持 100。这里没有大型递归子树，容量主要提供足够的当前会话撤销深度；改变容量前应结合实际版本正文体积重新决定。

[技术占位：记录 event 联合类型和 apply/invert 的稳定源码入口；不在文档重复五类 event 的字段表。]

## 草稿、`settle` 与同步门禁

controller 在用户主动保存重试、撤销、重做、上传和拉取前先应用同一份草稿门禁，因此这些命令正常开始时不存在未处理草稿。

`settle("remote-change")` 是唯一特殊路径：

- 有效新增草稿变成一次插入想法 event；
- 有效编辑草稿变成一次追加版本 event；
- 全空白或无实际变化的草稿取消；
- 最多返回一个 event。

其他 settle reason 在门禁正常生效时返回 `null`。这个特殊路径用于保证后台远端变化不会让有效草稿消失，不得扩展成自动上传或自动冲突解决。

[技术占位：分别记录联合草稿状态、手动门禁和 remote-change 结算的源码入口，说明它们必须复用同一正文有效性判断。]

## `project` 与实时投影

- 初始化依据完整 payload 建立列表。
- 撤销/重做后，若当前编辑对象或历史选择已经不存在，则清理相应实时状态。
- 搜索词可以跨完整投影保留并重新应用。
- 折叠状态从 payload 恢复；临时搜索展开、草稿、焦点和面板选择不从 payload 恢复。
- 卡片按 thought ID 稳定复用属于用户输入连续性的实现要求，但 DOM 本身不是业务真源。

[技术占位：分别记录 project、统一搜索投影和 keyed 卡片入口；textarea/IME 的局部实现放在 UI 源码，不进入 payload 说明。]

## 远端编码与 Schema

- 远端只管理 `data/fragment-thoughts/thoughts.json`。
- 文件表示完整业务 payload，使用稳定 JSON 编码和结尾换行；相同业务内容产生相同字节。
- codec 只接受约定的业务文件，不读取或生成 Shared 的 `revision.json`。
- decode 先解析原始 JSON；来源 schema 的迁移由 Runtime 处理，之后再执行当前 payload 完整校验。

当前业务 schema 为 v1。版本只存在于 Shared 的本地 envelope 和远端清单。缺失 schemaVersion 时不能自动当作 v1；真实旧数据转换必须按 [Schema 迁移手册](../../playbooks/schema-migration.md) 单独决定。

[技术占位：分别记录 codec、definition migration policy 和 content key 的源码入口；不嵌入示例 `thoughts.json`。]

## 变更本文的条件

只有想法/版本的持久化语义、折叠状态归属、event 粒度、草稿特殊结算、远端文件格式或 schema 策略变化时更新本文。搜索算法优化、组件拆分和样式变化不更新。
