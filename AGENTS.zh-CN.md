# Agent 指南

## 项目概览

这个仓库是一个个人仪表盘，用来承载多个用户自有的小工具。每个工具都应作为独立的功能模块存在，同时共享同一个仪表盘入口页面、构建系统和部署流水线。

应用部署到 GitHub Pages。源代码保留在仓库中；GitHub Actions 运行工作流来安装依赖、将 Vite 输出构建到 GitHub Pages 的临时工作目录里，并把生成的产物部署到 Pages。本地的 `dist/` 仅用于本地测试，不上传到 GitHub。

持久化的私有数据存储在这个应用仓库之外。需要持久化的模块应通过 GitHub Contents API，在用户自有的私有 GitHub 仓库中读写 JSON 文件。这样可以让仪表盘应用作为静态文件部署，同时把个人数据与公开的 Pages 站点分离。

## 开发原则

1. 尽早保持模块解耦。当逻辑开始混合独立职责时，在它变成大文件问题之前就进行抽离，优先使用小型、有类型的模块。常见边界包括 UI 渲染、浏览器存储、远程 API 访问、数据规范化、纯领域操作和页面级编排。

2. 做重要选择前先询问。如果遇到：

- 用户需求存在几种不同的解决方案，且不同选项对后续实际操作影响较大；
- 用户需求不清晰；
- 用户需求需要对项目进行重大变化。

请在编辑前使用自定义用户输入工具。不要在这些情况下替用户静默选择。

3. 除非用户明确要求改变，否则保留公开行为。现有路由、localStorage key、JSON 数据形状和部署假设都应视为兼容性表面。

4. TypeScript 类型应描述持久化数据、设置、API 响应和模块契约。除非是在验证未知外部数据的明确边界处，否则避免使用 `any`。

5. 使用安全的 DOM 模式。通过 `textContent` 或显式 DOM 节点渲染用户提供的内容，而不是 HTML 字符串模板。

## 当前功能模块

### Fragment Thoughts

路由：`/modules/thoughts/`

这个模块允许用户快速记录短想法、附加可选标签、在已加载列表中本地搜索。

## 架构

这个应用是一个 Vite 多页面 TypeScript 项目。HTML 文件定义稳定的公开页面壳，`src/` 下的 TypeScript 提供行为和样式导入。

重要路径：

- `index.html`：仪表盘首页页面壳。
- `modules/thoughts/index.html`：Fragment Thoughts 页面壳。保持该路由稳定。
- `src/home/`：仪表盘首页实现。
- `src/home/modules.ts`：首页上显示的仪表盘模块注册表。
- `src/shared/`：小型且真正跨模块共享的工具。
- `src/thoughts/`：Fragment Thoughts 模块实现。
- `vite.config.ts`：Vite 构建配置和多页面入口。
- `.github/workflows/pages.yml`：GitHub Pages 部署工作流。

添加新功能模块时，保持相同模式：

- 在 `modules/<module-id>/index.html` 下添加稳定的 HTML 页面壳。
- 在 `src/<module-id>/` 下添加模块源码。
- 在 `src/home/modules.ts` 中注册模块。
- 将 HTML 入口添加到 `vite.config.ts`，确保生产构建包含它。
- 保持模块特定的存储、API 客户端、数据操作、渲染和编排相互分离。

## 代码职责

对于功能模块，使用清晰的职责分层，而不是单个页面脚本：

- 设置/存储层：浏览器持久化，例如 localStorage key 和默认值。
- API 层：远程服务调用、headers、API 特定错误和请求/响应类型。
- 仓库层：加载/保存用例、JSON 解析、验证和向后兼容的规范化。
- 领域层：对模块数据的纯操作，例如创建、更新、删除、过滤、排序和解析。
- 视图层：DOM 查找、渲染和 UI 状态更新。
- 页面控制器：事件绑定，以及其他层之间的编排。

thoughts 模块当前遵循这个结构：

- `src/thoughts/settings.ts`
- `src/thoughts/githubContentApi.ts`
- `src/thoughts/thoughtRepository.ts`
- `src/thoughts/notes.ts`
- `src/thoughts/view.ts`
- `src/thoughts/main.ts`

避免将视图代码导入纯数据模块，也避免在渲染代码中调用 GitHub 或 localStorage API。

## GitHub Pages 部署

部署基于工作流：

1. 代码推送到 `main`，或从 GitHub Actions 手动启动工作流。
2. GitHub Actions 检出源代码。
3. 使用 `npm ci` 安装依赖。
4. 运行 `npm run build`。
5. 将 `dist/` 作为 Pages artifact 上传。
6. 将该 artifact 部署到 GitHub Pages。

仓库设置必须使用：

`Settings -> Pages -> Build and deployment -> Source -> GitHub Actions`

Vite 的 `base` 路径会在 Actions 构建期间根据 `GITHUB_REPOSITORY` 推导，因此这个仓库会部署在 `/my-dashboard/` 下。如果仓库名发生变化，请在部署前验证生成的资源路径。

## 私有 JSON 数据仓库

私有用户数据不存储在这个仪表盘仓库中。对于需要持久化的模块：

- 将数据作为 JSON 文件存储在单独的私有 GitHub 仓库中。
- 从浏览器通过 GitHub Contents API 访问这些文件。
- 使用限定到私有数据仓库、且拥有 Contents 读写权限的细粒度 token。
- token 只存储在用户的浏览器设置中。
- 将 JSON 格式视为兼容性契约。如果格式需要改变，请先询问用户。

## 检查和测试

使用以下命令进行代码级验证：

- `npm install`：需要时安装依赖。
- `npm run build`：交付代码变更前必须执行。它会运行 TypeScript 检查和生产 Vite 构建。
- `npm run preview`：仅在用户明确要求时，用于可选的生产预览。

`npm run dev` 以及基于浏览器的运行时测试、布局审查和用户验收测试由用户负责。不要自行启动开发服务器。
