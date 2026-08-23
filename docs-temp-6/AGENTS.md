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

Agent 可进行的修改当前限制在以下内容中：

    修改代码：

    - 已有模块的普通修改。
    - 更新已有持久化模块 schema。
    - 创建新模块，包括持久化模块和非持久化模块。
    - 修改 shared 相关代码。
    - 修改 home 相关代码。

    改动文档：

    - 维护直接与项目代码相关的文档（也包含其他文档中直接与项目代码相关的部分）。包括 `<module-id>.md`、`home.md`、`shared.md`、`shared-for-modules.md`、`persistent-module-integration.md`、`schema-updates.md`，以及 `AGENTS.md` 的一些部分。
    - 修改针对 Agent 其他行为的约束文档，或重构文档系统（删除或新增非 `<module-id>.md` 文档、大幅调整文档系统结构）。

# 开发流程

Agent 须根据该文档（`AGENTS.md`）的路由，在对应的节点阅读所需的文档；开发完成后，运行构建 `npm run build`。正常构建后依据 `AGENTS.md` 的说明和具体的开发内容，按需更新对应的文档。最后将修改提交到 Git。没有用户的要求，默认不做其他测试。即使测试，用于测试的文件也默认不保留。

# 文档路由与文档更新范围

- 需要修改非持久化模块时，读取对应的 `<module-id>.md`。按需更新对应 `<module-id>.md` 文档。
- 需要普通修改持久化模块时，先读取 `shared-for-modules.md`，然后读取对应的 `<module-id>.md`。按需更新对应 `<module-id>.md` 文档。
- 需要修改首页时，读取 `home.md`。按需更新 `home.md` 文档。
- 需要新增非持久化模块时，读取 `module-integration.md`。之后按照 `module-integration.md` 指引更新相关文档，并创建对应 `<module-id>.md` 文档。
- 需要新增持久化模块时，依次读取 `shared-for-modules.md` 和 `persistent-module-integration.md`。之后按照 `persistent-module-integration.md` 指引更新相关文档，并创建对应 `<module-id>.md` 文档。
- 需要更新持久化模块 schema 时，依次读取 `shared-for-modules.md`、对应的 `<module-id>.md` 和 `schema-updates.md`。之后按照 `schema-updates.md` 指引更新相关文档。
- 修改 shared 自身时，先读取 `shared-for-modules.md`，然后读取 `shared.md`。按需更新 `shared.md` 文档、`shared-for-modules.md` 文档、`persistent-module-integration.md` 文档和 `schema-updates.md` 文档。

- 更新文档前，请读取 `documentation-maintenance.md`。
- 修改与代码非直接相关的约束内容或重构文档系统前，请读取 `documentation-system.md`，然后读取 `documentation-maintenance.md`。

- 创建新模块或其他情况有需要修改 UI、样式或交互时，读取并遵守 `ui-guidelines.md`。

- 每次开发流程前，查看 `special-development-notes.md`。（此文档的内容依开发环境和开发者的偏好而不同，可能不存在或内容为空）

- 每次开发流程前，查看 `universal-constraint.md`。

**改动涉及多个目标时，取各目标路由文档的并集，并先读 `shared-for-modules.md`。**