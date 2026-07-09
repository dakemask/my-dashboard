# 代理指南

## 项目概览

这个仓库是一个个人仪表盘，用于承载多个由用户自有的小工具。每个工具都应作为独立的功能模块存在，同时共享同一个仪表盘入口页、构建系统和部署流水线。

应用部署到 GitHub Pages。源代码保留在仓库中；GitHub Actions 运行工作流，安装依赖，在 GitHub Pages 的临时工作目录中构建 Vite 输出，并将生成的产物部署到 Pages。本地 `dist/` 目录只用于本地测试，不会上传到 GitHub。

持久化的私有数据存放在这个应用仓库之外。需要持久化的模块应通过 GitHub Contents API，在用户自有的私有 GitHub 仓库中读写 JSON 文件。这样可以让仪表盘应用继续作为静态文件部署，同时将个人数据与公开的 Pages 站点分离。

## **开发原则**

1. 尽早保持模块解耦。当一个文件开始混合独立职责时，在它变成大文件问题之前就要拆分，并优先使用小型、带类型的模块。常见边界包括 UI 渲染、浏览器存储、远程 API 访问、数据规范化、纯领域操作和页面级编排。

2. 尽量保持状态模型的自洽，在项目的技术实现上保持自洽顺畅。反例有语义重叠、奇怪而难以维护的功能实现方式、不考虑整体实现的bug修复方式。

3. 新功能、修深层bug前先询问。用户在提出新功能、要求修复bug时可能不会意识到他们的需求的复杂性。如果贸然接受用户的需求，可能导致一个个小需求积累成臃肿不规范的状态模型、或是过重的文件，这会与前两点产生冲突。如果有这种潜在风险，请在编辑前使用自定义工具 `custom_request_user_input` 向用户进行询问。

## 项目架构

这个应用是一个 Vite 多页面 TypeScript 项目。HTML 文件定义稳定的公开页面外壳，`src/` 下的 TypeScript 提供行为逻辑和样式导入。

重要项目路径：

- `index.html`：仪表盘首页外壳。
- `src/home/`：仪表盘首页实现。
- `src/home/modules.ts`：首页展示的仪表盘模块注册表。
- `src/shared/`：小型且真正跨模块共享的工具。
- `src/shared/privateData/`：共享的私有 GitHub 仓库设置、GitHub Contents API 访问和 JSON 文件持久化。
- `vite.config.ts`：Vite 构建配置和多页面入口。
- `.github/workflows/pages.yml`：GitHub Pages 部署工作流。

## 功能模块

### Fragment Thoughts

路由：`/modules/thoughts/`

HTML 外壳：`modules/thoughts/index.html`

源码：`src/thoughts/`

功能：快速记录短想法，附加可选标签，并在已加载列表中进行本地搜索。

职责：

- `thoughtRepository.ts`：模块 JSON 持久化、解析、验证和向后兼容的规范化。
- `notes.ts`：纯想法操作，例如创建、更新、删除、筛选、排序和解析。
- `types.ts`：想法模块专用的持久化数据和模块状态类型。
- `view.ts`：DOM 查找、渲染和 UI 状态更新。
- `main.ts`：页面控制器、事件绑定，以及其他层之间的编排。
- `style.css`：模块专用展示样式。

持久化：

- 使用 `src/shared/privateData/` 下的共享私有 JSON 仓库辅助工具。
- 将想法模块专用的 JSON 兼容性和规范化保留在该模块内部。

兼容性：

- 保持 `/modules/thoughts/` 稳定。
- 除非明确变更，否则保留现有 localStorage 键和 JSON 数据形状。

### Mind Map

路由：`/modules/mind-map/`

HTML 外壳：`modules/mind-map/index.html`

源码：`src/mind-map/`

目的：在交互式思维导图画布上创建、编辑、移动、调整大小并连接文本框。

职责：

- `mindMapRepository.ts`：模块 JSON 持久化、解析、验证和向后兼容的规范化。
- `mindMap.ts`：纯思维导图操作，例如创建、更新、删除，以及连接节点和箭头。
- `types.ts`：思维导图持久化数据、节点/箭头、选择状态、框架和状态类型。
- `view.ts`：DOM 查找，以及工具栏、设置、状态、上下文菜单和模式 UI 更新。
- `domSvgMapView.ts`：DOM/SVG 画布渲染、指针交互、文本编辑、选择、调整大小手柄、连接器、箭头、平移和缩放。
- `domSvgMapElements.ts`：DOM/SVG 元素工厂，以及画布视图使用的低层可编辑文本、光标、指针捕获和 SVG 线条辅助工具。
- `nodeFrame.ts`：节点框架几何、调整大小手柄元数据、端点定位和框架比较辅助工具。
- `textBoxLayout.ts`：文本框测量、编辑期间的高度适配、自动宽度行为和调整大小提交时的适配。
- `mindMapLibrary.ts`：思维导图库的纯路径、名称验证、树查找、树变更、排序和路径前缀辅助工具。
- `mindMapWorkspace.ts`：本地优先的工作区状态模型。它拥有 `tree`、`maps`、`dirtyContentPaths`、`dirtyTree`、`treeChangePaths`、`remoteShaByPath`、远程未知文件保护数据，以及旧本地缓存规范化。
- `mindMapLibraryRepository.ts`：用于思维导图库文件夹、`.json` 导图和 `.gitkeep` 占位文件的 GitHub 目录遍历与受管理文件传输。
- `mindMapLocalStore.ts`：用于思维导图工作区快照的 IndexedDB 存储。
- `mindMapSync.ts`：GitHub/IndexedDB 同步用例：加载本地工作区、保存本地工作区、从 GitHub 刷新工作区，以及将工作区变更上传到 GitHub。
- `mindMapLibraryActions.ts`：文件树用户操作，例如创建、重命名、移动和删除文件夹/导图，并包含名称/路径验证和非受管理文件保护。
- `main.ts`：页面控制器、事件绑定、撤销/重做、空闲刷新检查，以及工作区、同步、图库操作、领域操作和视图层之间的协调。
- `style.css`：模块专用展示样式。

持久化：

- 使用 `src/shared/privateData/` 下的共享私有 GitHub Contents API 辅助工具。
- 设置中的 `path` 字段是思维导图库根路径。默认值为 `data/mind-maps/`；已存储的旧默认值 `data/mind-map.json` 会被视为未设置，并规范化为图库根路径。
- 每个导图都保持为普通的 `MindMapData` JSON 文件，形状为 `{ nodes, arrows }`；导图名称来自文件名，不会包裹在元数据中。
- 浏览器 IndexedDB 是整个工作区的主要工作缓存。页面打开、手动刷新，或超过两小时不活动后执行操作前，都会从 GitHub 刷新工作区。用户编辑会先更新本地工作区。
- 保存会将本地工作区上传到 GitHub。新路径在创建时不会复用旧文件 SHA；删除的远程受管理文件会使用 `remoteShaByPath` 删除；空文件夹用 `.gitkeep` 表示。
- 文件树只管理文件夹、`.json` 导图文件和 `.gitkeep`。如果上次 GitHub 刷新发现某个文件夹下存在非受管理文件，则会阻止对该文件夹进行移动、重命名或删除。
- 旧的 `data/mind-map.json` 单文件导图会被多导图库刻意忽略，不会自动导入或迁移。

兼容性：

- 保持 `/modules/mind-map/` 稳定。
- 除非明确变更，否则保留现有设置 localStorage 键和单导图 `{ nodes, arrows }` JSON 形状。
- 修改 IndexedDB 快照形状时，在 `mindMapWorkspace.ts` 中保留旧浏览器本地思维导图工作区缓存的规范化。

## 添加功能模块

添加新功能模块时，保持相同模式：

- 在 `modules/<module-id>/index.html` 下添加稳定的 HTML 外壳。
- 在 `src/<module-id>/` 下添加模块源码。
- 在 `src/home/modules.ts` 中注册模块。
- 在 `vite.config.ts` 中添加 HTML 入口，确保生产构建包含它。
- 将模块专用的存储、API 客户端、数据操作、渲染和编排分离。

## 模块设计规则

对于功能模块，使用清晰的职责分层，而不是单个页面脚本：

- 设置/存储层：浏览器持久化，例如 localStorage 键和默认值。
- API 层：远程服务调用、请求头、API 专用错误和请求/响应类型。
- 仓库层：加载/保存用例、JSON 解析、验证和向后兼容的规范化。
- 领域层：对模块数据的纯操作，例如创建、更新、删除、筛选、排序和解析。
- 视图层：DOM 查找、渲染和 UI 状态更新。
- 页面控制器：事件绑定，以及其他层之间的编排。

避免将视图代码导入纯数据模块，也避免从渲染代码中调用 GitHub 或 localStorage API。功能模块应将自己的 JSON 形状规范化保留在模块内部，而共享私有数据模块负责仓库设置、文件传输和通用 JSON 读写行为。

## GitHub Pages 部署

部署基于工作流：

1. 代码推送到 `main`，或从 GitHub Actions 手动启动工作流。
2. GitHub Actions 检出源代码。
3. 使用 `npm ci` 安装依赖。
4. 运行 `npm run build`。
5. 将 `dist/` 上传为 Pages artifact。
6. 将该 artifact 部署到 GitHub Pages。

仓库设置必须使用：

`Settings -> Pages -> Build and deployment -> Source -> GitHub Actions`

Vite 的 `base` 路径在 Actions 构建期间由 `GITHUB_REPOSITORY` 派生，因此这个仓库会部署在 `/my-dashboard/` 下。如果仓库名称变更，请在部署前验证生成的资源路径。

## 私有 JSON 数据仓库

私有用户数据不存储在这个仪表盘仓库中。对于需要持久化的模块：

- 将数据作为 JSON 文件存储在单独的私有 GitHub 仓库中。
- 通过浏览器使用 GitHub Contents API 访问这些文件。
- 使用仅限该私有数据仓库、并具有 Contents 读写权限的 fine-grained token。
- 只在用户的浏览器设置中存储 token。
- 将 JSON 格式视为兼容性契约。如果格式需要变更，先询问用户。

共享私有数据持久化代码属于 `src/shared/privateData/`。模块专用仓库应调用共享 JSON 文件辅助工具，并将模块专用数据规范化保留在功能模块中。

## 检查与测试

使用以下命令进行代码级验证：

- `npm install`：需要时安装依赖。
- `npm run build`：交付代码变更前必须运行。它会执行 TypeScript 检查和生产 Vite 构建。
- `npm run preview`：仅在用户明确要求时用于可选的生产预览。

`npm run dev`、基于浏览器的运行时测试、布局审查和用户验收测试由用户负责。不要自行启动开发服务器。
