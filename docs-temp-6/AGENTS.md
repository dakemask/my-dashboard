# 项目概述

My Dashboard 是一个使用 TypeScript 和 Vite 构建的多页面浏览器应用。根页面 home 负责模块入口和账户管理；各业务模块拥有独立页面，并在 `src/<module-id>/` 中维护自己的领域模型、应用编排和 UI。

项目的模块可以是持久化模块，也可以是非持久化模块。持久化模块的重要数据在 GitHub 远端私人仓库进行存储，在本地也有存放。持久化模块的非重要数据和非持久化模块的数据都存放在本地。

未指定远端仓库时，项目中的各模块依然可以以本地模式运行。此时所有数据均储存在本地。

包含持久化数据的模块自行定义 payload schema、业务事件和页面行为。`src/shared` 为这些模块提供公共运行基础，使模块数据接入统一的本地持久化、账户隔离和云端同步流程。

当前持久化业务模块包括：

- `fragment-thoughts`：短文本想法、版本历史与搜索。
- `mind-maps`：分层资料库与空间画布。
- `todos`：待办实例、周期规则与任务树。

当前非持久化模块包括：

（暂无）

# Agent 能力范围

Agent 可进行的修改与开发限制在以下内容中：

- 已有模块的普通修改。
- 更新已有持久化模块 schema。
- 创建新模块，包括持久化模块和非持久化模块。
- 修改 shared 相关代码。
- **根据代码变化更新文档中的信息**，此条只涉及代码信息压缩，不涉及约束内容。一般需要更新的文档是 `<module-id>.md`。也可能是`shared.md`、`home.md`、`AGENTS.md`。剩余文档的预期更改频率非常低。
- 修改针对 Agent 行为的**约束内容**，或**重构当前文档体系**。

# 文档路由与基本行为

- 需要修改非持久化模块时，读取对应的 `<module-id>.md`。必要时更新对应 `<module-id>.md` 文档。
- 需要普通修改持久化模块时，先读取 `shared-for-modules.md`，然后读取对应的 `<module-id>.md`。必要时更新对应 `<module-id>.md` 文档。
- 需要修改首页时，读取 `home.md`。必要时更新 `home.md` 文档。
- 需要新增非持久化模块时，读取 `module-integration.md`。之后按照 `module-integration.md` 指引更新相关文档，并创建对应 `<module-id>.md` 文档。
- 需要新增持久化模块时，依次读取 `shared-for-modules.md` 和 `persistent-module-integration.md`。之后按照 `persistent-module-integration.md` 指引更新相关文档，并创建对应 `<module-id>.md` 文档。
- 需要更新持久化模块 schema 时，依次读取 `shared-for-modules.md`、对应的 `<module-id>.md` 和 `schema-updates.md`。之后按照 `schema-updates.md` 指引更新相关文档。
- 修改 shared 自身时，先读取 `shared-for-modules.md`，然后读取 `shared.md`。必要时更新 `shared.md` 文档、`shared-for-modules.md` 文档、`persistent-module-integration.md` 文档和 `schema-updates.md` 文档。

- 根据代码变化更新文档信息前，请读取 `documentation-maintenance.md`。
- 修改约束内容或重构文档体系前，请读取 `documentation-architecture.md`，然后读取 `documentation-maintenance.md`。

- 需要修改 UI、样式或交互时，读取并遵守 `ui-guidelines.md`。

- `special-development-notes.md` 中包含以下约束，请按需读取：

（暂无）

- `things-you-must-not-do.md` 中包含以下约束，请按需读取：

（暂无）

**改动涉及多个目标时，取各目标路由文档的并集，并先读 `shared-for-modules.md`。**