# my-dashboard

## 项目与仓库

本项目是由多个独立模块组成的个人仪表盘。

- `my-dashboard` 是公开源码仓库。推送到 `main` 后，GitHub Actions 自动测试、构建并部署到 GitHub Pages。
- `my-dashboard-data` 是私人数据仓库。需要持久化的模块通过用户提供的 GitHub 用户名和 token 访问其 `main` 分支，以保存隐私数据并支持跨设备同步。

## 架构概览

本项目是使用 TypeScript 和 Vite 构建的多页面静态前端，没有自建后端。首页和各模块拥有独立 HTML 入口，由 Vite 统一构建并部署到 GitHub Pages。

| 位置 | 职责 |
| --- | --- |
| `index.html`、`src/home/` | 首页、账户设置、首次账户接入和模块导航 |
| `modules/<module>/index.html` | 模块页面入口 |
| `src/<module>/` | 模块的业务规则、页面状态和 UI |
| `src/shared/` | 持久化模块共用的认证、本地保存、GitHub 同步、历史、编辑锁和公共操作 UI |
| `tests/` | Shared 通用测试和各模块的 domain/codec 测试，开发完成后需要运行 `npm test`，进行简单的初步验证 |
| `vite.config.ts` | 首页和模块页面的构建入口 |

持久化模块把业务动作表示为 event，并维护完整 payload；Shared runtime 负责历史、本机保存和云端同步。没有账户时默认使用本地模式；添加首个账户后进入账户模式，并可在多个 GitHub 账户间切换。

数据路径：

    模块 UI → 模块 event/payload → Shared runtime → 当前 profile 的 IndexedDB
                                             → 账户模式：GitHub API → my-dashboard-data

模块负责自身业务和页面交互，Shared 负责平台能力。业务模块只通过 `src/shared` 根入口使用 Shared。

## 模块目录

| moduleId            | 用途               | 状态   | 是否持久化 | 长期文档                           |
| ------------------- | ------------------ | ------ | ---------- | ---------------------------------- |
| `mind-maps`         | 绘制和管理思维导图 | 已实现 | 是         | [Mind Map](./.agents/mind-maps.md) |
| `fragment-thoughts` | 记录碎片想法       | 已实现 | 是         | [碎片想法](./.agents/fragment-thoughts.md) |
| `todos`             | 管理待办与周期任务 | 已实现 | 是         | [待办](./.agents/todos.md) |

简单模块可以不建立专用文档；需要长期维护说明的模块只维护一份长期文档。

模块文档首先记录模块自身的业务规则、用户操作和代码结构；使用持久化 SDK 时，再记录本模块具体的 payload、event、历史容量、hooks 和远端编码，不重复公共 SDK 原理。

## 任务路由

| 任务 | 必须阅读 |
| --- | --- |
| 维护持久化模块 | [持久化模块公共契约](./.agents/persistent-module-contract.md)；该模块的长期文档（如果存在） |
| 创建持久化模块，或重做 SDK 接线 | [持久化模块公共契约](./.agents/persistent-module-contract.md)；[新持久化模块接入指南](./.agents/new-persistent-module-guide.md)  |
| 开发不持久化模块 | 该模块的长期文档（如果存在） |
| 修改 `src/shared`、首页认证、持久化或同步基础设施 | 先获得用户明确允许；再读 [持久化模块公共契约](./.agents/persistent-module-contract.md) 和 [Shared 维护](./.agents/shared-maintenance.md) |

## 文档同步

变更模块目录、开发状态、任务路由或项目级规则时，同步更新本文件。变更用户操作、业务规则、持久化定义或代码职责时，同步更新对应模块文档。变更 Shared 的公共行为或内部维护方式时，同步更新持久化模块公共契约或 Shared 维护规范。

## 验证

Agent 完成开发后运行以下命令：

```bash
npm test
npm run build
```

一般来说，实际页面的呈现和交互体验由用户验收。Agent 可在对话中给出验收清单。

没有用户或文档内容的允许，Agent 禁止进行其他验收，也禁止自行增添其他测试文件或修改现有测试文件。对于需要测试的场景，Agent 可通过自定义工具 `airuma_custom.custom_request_user_input` 向用户进行申请。

## 最高级规则

- 需要保存业务数据的模块必须使用 `src/shared` 根入口提供的 SDK；不保存数据的模块不要求使用。
- 未经用户明确允许，不得修改 Shared，也不得访问、修改或迁移真实 `my-dashboard-data` 数据。
- token 不得进入 DOM、日志、错误文本、业务 payload 或 event 历史。

## 常见实际问题与其他规范

本节记录在日常开发中稳定触发、会造成重复失败的问题；以及一些其他的开发规范。

- Vite 和 Vitest 需要启动 esbuild 子进程；不要在受限 sandbox 中运行 `npm test` 或 `npm run build`，直接申请沙箱外权限执行。
- 适合用图标表达的按钮（尤其是工具栏、重复操作和空间紧凑的常见动作）必须使用图标。图标统一使用字节跳动 IconPark 的 `@icon-park/svg`，由 TypeScript 引用并通过 Vite 直接编译进构建产物。纯图标按钮必须同时提供准确的 `aria-label` 和 `title`。
- 所有 UI 的内联文字编辑必须“无感”：输入、校验失败等场景下，文字的字号、行高，以及编辑区域的宽高、内外边距等都应与只读态保持基本一致，不得发生布局跳动。实现时优先让同一输入控件在只读态与编辑态间切换。
- 随时使用自定义工具 `airuma_custom.custom_request_user_input` 与用户进行交流，向用户确认选择，以防止潜在的误解。
