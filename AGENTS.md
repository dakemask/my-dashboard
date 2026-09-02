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

Agent 须根据该文档（`AGENTS.md`）的路由，按需阅读所需的文档与代码；了解完所需信息后进行开发；开发完成后，按需进行构建、复核与测试。然后依据 `AGENTS.md` 的说明和具体的开发内容，按需更新对应的文档。

# 文档路由

按照以下的说明，自行读取相关文档。

## 模块文档

- `docs/shared-for-modules.md`：修改和创建持久化模块时需要了解的信息。为那些需要修改持久化模块而又无需修改底层 shared 的需求提供轻量说明。

- `docs/<module-id>.md`：修改对应模块时需要了解的信息。

- `docs/shared.md`：修改底层 shared 本身时需要了解的信息。阅读前需要先阅读 `shared-for-modules.md`。

- `docs/home.md`：修改首页时需要了解的信息。

## 任务文档

- `docs/module-integration.md`：以步骤形式指引 Agent 完成非持久化新模块的创建和接入。

- `docs/persistent-module-integration.md`：以步骤形式指引 Agent 完成持久化新模块的创建和接入。

- `docs/schema-updates.md`：以步骤形式指引 Agent 完成涉及 schema 变动的持久化模块修改。

## 元文档

- `docs/documentation-maintenance.md`：介绍更新文档信息时需要了解的方法论与约束。在代码改动完毕后，更新文档前读取。

- `docs/documentation-system.md`：介绍修改约束文档、重构文档体系时需要了解的方法论与约束。非这两点需求，不进行读取。

## 其他文档

- `docs/ui-guidelines.md`：介绍 UI 设计的方法论与约束。

- `docs/special-development-notes.md`：介绍 Agent 执行指令、使用工具时的技巧。（此文档的内容依开发环境和开发者的偏好而不同，可能不存在或内容为空）

# 文档更新

每次文档更新前，必须读取 `docs/documentation-maintenance.md`。

只更新阅读过的文档。一般只更新模块文档与任务文档。是否更新需在阅读过 `docs/documentation-maintenance.md` 后做出决定。