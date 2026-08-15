# my-dashboard 项目规则（结构示例）

> 这是未来仓库根 `AGENTS.md` 的一比一示例，只在 `documentation-blueprint/repository-root/` 范围内用于展示，不会替换当前项目规则。

## 项目事实

本项目是 TypeScript + Vite 构建的多页面静态个人仪表盘，没有自建后端。

- `my-dashboard` 是公开代码仓库；`main` 通过 GitHub Actions 测试、构建并部署到 GitHub Pages。
- `my-dashboard-data` 是用户自行创建的私人数据仓库，仅供账户模式跨设备同步。
- 首页位于 `index.html` 和 `src/home/`；模块入口位于 `modules/`，业务源码位于 `src/<module>/`。
- 持久化平台能力集中在 `src/shared/`；业务模块只能通过 `src/shared` 根入口使用它。

当前模块：

| moduleId | 用途 | 持久化 |
| --- | --- | --- |
| `mind-maps` | 思维导图资料库 | 是 |
| `fragment-thoughts` | 碎片想法及版本 | 是 |
| `todos` | 待办、子任务和周期规则 | 是 |

模块入口、构建入口和注册状态以源码为准，本表只帮助识别产品范围，不复制文件清单。

## 不可越过的边界

- 未经用户明确允许，不得修改 `src/shared`、首页认证、同步基础设施或账户接入流程。
- 不得读取、修改、迁移或模拟操作用户真实的 `my-dashboard-data` 数据。
- token 不得进入 DOM、URL、日志、错误文本、业务 payload、event 历史、Git commit 或测试快照。
- 需要保存业务数据的模块必须使用 `src/shared` 根入口提供的 SDK，不得自行建立 IndexedDB 或 GitHub 同步实现。
- 冲突不得自动合并，也不得暗中选择本地或云端覆盖方向。
- 每次完成修改后提交到本地 Git；除非用户另有要求，不推送 GitHub。

这些边界始终有效，不因任务很小、已有代码看似采用另一种做法或 playbook 中存在示例而失效。

## 工作行为

- 先判断本次任务改变的是视觉、用户行为、业务数据、持久化边界还是平台能力，再按下表读取最少文档。
- 不得仅因为一个模块“是持久化模块”就阅读全部持久化文档。
- 纯重构如果不改变用户行为、数据格式或公共边界，默认以代码和类型为依据，不为了解背景通读产品文档。
- 用户已经明确给出视觉或交互结果时，应直接按该结果工作；只有缺失选择会明显改变产品行为、数据或安全结果时才询问。
- 诊断或评审任务默认只读；实现任务才修改文件。不要把“查看问题”扩展成“顺手修复”。
- 发现文档与代码不一致时，不要自动把二者改成一致。先判断文档描述的是产品意图、公共契约还是已经过时的实现复述，再决定修代码、修文档或向用户报告。

## 任务路由

多个触发条件可以叠加；只读取被实际触发的文档。没有出现在“必须阅读”列中的文档，不因“可能有帮助”而顺手通读。

| 任务触发条件 | 必须阅读 | 明确不必阅读 |
| --- | --- | --- |
| 用户已明确目标的纯 CSS、间距、颜色、图标或文案修正 | [UI 规范](./.agents/conventions/ui.md) | 模块持久化说明、公共持久化契约、Shared 维护文档 |
| 改变某模块的用户操作、业务规则或可见结果 | 该模块的 `product.md`；涉及全局交互时再读 [UI 规范](./.agents/conventions/ui.md) | 未触及数据边界时不读公共持久化契约 |
| 只重构模块内部代码，且行为、格式和边界不变 | 默认不读额外文档；从代码、类型和现有测试定位 | 模块产品说明和持久化说明不自动成为前置阅读 |
| 修改 payload、event、definition、codec、历史策略、`settle` 或 `project` | [公共持久化契约](./.agents/contracts/persistent-module.md) + 该模块的 `persistence.md`；若行为也变化，再加 `product.md` | Shared 内部维护文档 |
| 新增或改变业务 schema 版本、迁移函数或旧数据兼容 | 上一行全部内容 + [Schema 迁移手册](./.agents/playbooks/schema-migration.md) | 无关模块文档 |
| 创建新的持久化模块，或重做整个 SDK 接线 | [公共持久化契约](./.agents/contracts/persistent-module.md) + [新模块接入手册](./.agents/playbooks/new-persistent-module.md) + 新模块产品决定 | 现有三个模块的完整文档；只按手册指定查看一个参考实现 |
| 修改 `src/shared`、首页认证、账户接入、同步或锁 | 先取得用户明确允许；再读 [公共持久化契约](./.agents/contracts/persistent-module.md) 和 [Shared 维护](./.agents/platform/shared.md) | 所有模块产品文档，除非公共行为变化确实影响该模块 |
| 决定测试、构建或人工验收范围 | [验证规范](./.agents/conventions/verification.md) | 与被验证行为无关的模块文档 |
| 调整文档结构、路由、保留标准或删除文档 | [文档维护规范](./.agents/documentation-policy.md) | Shared 和模块技术文档，除非正在核对其中的具体内容 |
| 连续且不改写的大段代码搬移 | 仅在确认满足条件后读 [大文件搬移手册](./.agents/playbooks/large-file-refactor.md) | 其他 playbook |

模块文档位置：

| 模块 | 产品行为 | 持久化决定 |
| --- | --- | --- |
| Mind Maps | [.agents/modules/mind-maps/product.md](./.agents/modules/mind-maps/product.md) | [.agents/modules/mind-maps/persistence.md](./.agents/modules/mind-maps/persistence.md) |
| 碎片想法 | [.agents/modules/fragment-thoughts/product.md](./.agents/modules/fragment-thoughts/product.md) | [.agents/modules/fragment-thoughts/persistence.md](./.agents/modules/fragment-thoughts/persistence.md) |
| 待办 | [.agents/modules/todos/product.md](./.agents/modules/todos/product.md) | [.agents/modules/todos/persistence.md](./.agents/modules/todos/persistence.md) |

## 各类事实的权威来源

| 问题 | 权威来源 |
| --- | --- |
| 用户想要什么 | 用户当前请求；不明确且会造成实质差异时向用户确认 |
| 用户可见行为应当怎样 | 对应模块的 `product.md` |
| 跨模块持久化语义 | `contracts/persistent-module.md` |
| 当前函数签名、字段和文件位置 | TypeScript 源码 |
| 当前实现是否满足可执行规则 | 自动测试和构建结果 |
| Shared 内部必须保持的安全与兼容约束 | `platform/shared.md` |
| 某次少见工作的操作方法 | 对应 playbook；它不是产品契约 |

源码与文档承担不同职责，因此“源码不同”不自动证明产品文档错误，“文档不同”也不自动证明源码必须修改。

## 文档同步

只在以下事实有意发生变化时更新文档：

- 项目级权限、安全边界或任务路由；
- 用户可见且需要长期保持的产品行为；
- 跨模块公共契约或外部数据兼容要求；
- 模块特有且无法从定义代码直接判断的持久化决定；
- playbook 所依赖的环境事实已经变化。

文件改名、类拆分、函数迁移、当前实现步骤或测试文件增减，默认不更新长期文档。不得在任务结束时追加开发过程总结、完整源码清单或“本次修改了什么”式段落；Git 历史负责记录这些内容。

## 验证与提交

- 文档或简单直接的代码修改，不因形式要求强制运行测试。
- 复杂逻辑、跨文件行为或构建入口变化，按 [验证规范](./.agents/conventions/verification.md) 执行。
- 未经用户或既有规范允许，不新增或修改测试文件，也不连接真实数据做验收。
- 提交前检查实际 diff，只提交本次任务范围内的文件；工作区中原有的用户改动必须保留。
