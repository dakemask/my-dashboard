# Mind Maps 持久化决定

## 何时阅读

修改 Mind Maps 的 payload、event、历史、definition、codec、schema、自动保存边界、`settle` 或 `project` 时阅读，并同时阅读 [公共持久化契约](../../contracts/persistent-module.md)。

只改资料库或画布的可见交互时读 [product.md](./product.md)，不必读取本文。

## 模块边界

- `moduleId` 固定为 `mind-maps`。
- 整个资料库使用一个完整 payload、一个本地保存边界、一个同步/冲突边界和一条会话历史。
- payload 包含全部文件夹和脑图；每张脑图包含自身稳定 ID、逻辑路径、节点和箭头。
- schemaVersion、revision、保存时间、pending、conflict、编辑锁和 event 历史不进入 payload。

这里保留 `moduleId` 是因为它同时决定已经存在的远端目录和本地数据隔离键，属于兼容承诺，而不只是一个可搜索的当前常量。

[技术占位：记录当前 definition 和 payload validator 的两个稳定源码入口；不复制 `MindMapPayload` interface。]

## 持久化与实时状态的分界

进入 payload：

- 文件夹路径和全部脑图业务内容；
- 节点文字、最终 frame 与宽度模式；
- 箭头端点和对象稳定身份。

不进入 payload：

- 当前脑图、资料库选择、画布选择、焦点和悬停；
- 名称/文字草稿、pointer、拖放、临时移动和 resize frame；
- 框选、连线模式、自动平移和每张脑图 viewport；
- 侧栏开关、最近脑图、展开文件夹等本机 UI 偏好。

本机 UI 偏好不得影响 content key 或云端文件。偏好损坏时可以安全回到默认状态，不能阻止业务 payload 启动。

[技术占位：分别记录 UI preference 的存储入口和 payload content key 的源码入口，说明二者不得互相依赖。]

## Event 粒度与历史

业务 event 按用户动作分为以下概念组，不在文档复制完整联合类型：

- 文件夹的创建、递归删除/恢复和原子移动；
- 脑图的创建、删除/恢复和移动；
- 节点的添加、文字与最终布局提交、移动和 resize；
- 箭头添加；
- 节点与箭头混合删除/恢复。

一次有效名称提交、合法 drop、确认删除、文字提交、pointerup 移动/resize、合法连线或批量删除各占一步。拖动中间状态、viewport 和选择不进入历史。

历史容量保持 100，因为递归删除文件夹和混合对象删除的 inverse 可能携带完整子树，需要限制页面会话内存；这不是 payload 大小限制。改变容量前应依据实际 event 体积和用户撤销需求重新决定。

[技术占位：分别记录 event 联合类型、apply/invert 和 payload diff 的稳定源码入口；字段级约束由代码和测试负责。]

## `settle` 的模块特例

自动保存紧跟在一个 event 之后时，`settle("local-save")` 不结算这个 event 之后刚开始的新交互。例如新增空节点后立即进入文字编辑，保存“新增节点”不能顺便提交用户尚未完成的文字。

保存重试、上传、拉取、远端变化、撤销和重做使用统一结算：

1. 结束资料库拖放及悬停展开；
2. 优先把有效名称草稿变成一个 event，无效名称草稿取消；
3. 没有名称 event 时，提取一个有效节点文字 event；
4. 取消未完成移动、resize、框选、连线和平移，停止自动平移并释放 pointer；
5. 退出箭头模式并清理选择；
6. 最多返回步骤 2 或 3 中的一个 event。

这个顺序是模块数据安全决定，不能因 controller 重构而改变。尤其不能一次 settle 绕过 Runtime 连续 dispatch 多个互不相关动作。

[技术占位：记录 settle 实现入口和各实时组件的统一 cancel/dispose 协议；不复制调用代码。]

## `project` 的模块特例

- 初始化只恢复仍然存在的最近脑图；不存在时清除偏好，不猜测打开另一张图。
- 撤销/重做后依据 before/after payload 差异定位受影响脑图或资料库项目，但不恢复旧的画布选择和编辑状态。
- 完整投影取消名称、文字、pointer、箭头模式和临时 frame；当前页面内按 map ID 保存的 viewport 可以继续保留。
- 只有保存时间、pending 或 conflict 变化的 snapshot 不应触发整个资料库和画布重建，以免中断输入法和实时指针操作。

[技术占位：分别记录 project、历史焦点计算和 keyed renderer 的稳定入口；DOM 复用算法不写进持久化决定。]

## 远端编码与兼容

- 远端根固定为 `data/mind-maps/`。
- 每张脑图编码为 `<逻辑路径>.json`；路径承载脑图名称和位置，文件内容不重复路径。
- 空叶文件夹用该目录内的 `.gitkeep` 表示，避免空目录在 Git 中消失。
- codec 只管理合法脑图 JSON 和必要的 `.gitkeep`，不生成 Shared 的 `revision.json`。
- decode 从受管路径恢复逻辑路径并补齐祖先文件夹；非法路径、损坏 JSON、重复身份或无效连接必须拒绝。
- 相同业务 payload 必须产生稳定、排序一致且逐字节相同的受管文件。

当前业务 schema 为 v1。版本由 Shared 的本地 envelope 和云端清单保存，不进入每张脑图业务文件。缺失版本不能自动解释为 v1；真实旧数据的任何转换必须按 [Schema 迁移手册](../../playbooks/schema-migration.md) 单独决定。

[技术占位：分别记录 codec encode/decode、稳定排序和旧版本 migration 的源码入口；不要在文档嵌入示例脑图 JSON。]

## 变更本文的条件

只有资料库持久化边界、实时/业务状态归属、event 粒度、历史容量理由、settle/project 特例、远端路径格式或 schema 兼容策略变化时更新本文。文件拆分、类改名和渲染实现变化不更新。
