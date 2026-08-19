# 项目概述

My Dashboard 是一个使用 TypeScript 和 Vite 构建的多页面浏览器应用。根页面负责模块入口和账户管理；各业务模块拥有独立页面，并在 `src/<module-id>/` 中维护自己的领域模型、应用编排和 UI。

包含持久化数据的模块自行定义 payload schema、业务事件和页面行为。`src/shared` 为这些模块提供公共运行基础，使模块数据接入统一的本地持久化、账户隔离和云端同步流程。

当前持久化业务模块包括：

- `fragment-thoughts`：短文本想法、版本历史与搜索。
- `mind-maps`：分层资料库与空间画布。
- `todos`：待办实例、周期规则与任务树。

# 文档路由

只读取与当前任务直接相关的文档：

- 修改或分析任一持久化业务模块时，先读 `shared-for-modules.md`，了解项目、模块与 Shared 的关系；再读该模块自己的文档。
- 处理 `fragment-thoughts` 时读 `fragment-thoughts.md`。
- 处理 `mind-maps` 时读 `mind-maps.md`。
- 处理 `todos` 时读 `todos.md`。
- 新增持久化模块时读 `persistent-module-integration.md`，并同时读 `shared-for-modules.md`。
- 修改或分析 Shared 自身实现时读 `shared.md`。模块内部的小改动不需要读取该文档。

`docs-temp-6` 是当前文档目录。不要读取 `docs-backup`、`docs-temp-1`、`docs-temp-2`、`docs-temp-3`、`docs-temp-4` 或 `docs-temp-5`。
