# my-dashboard

## 项目与仓库

本项目是由多个独立模块组成的个人仪表盘。

- `my-dashboard` 是公开源码仓库。推送到 `main` 后，GitHub Actions 自动测试、构建并部署到 GitHub Pages。
- `my-dashboard-data` 是私人数据仓库。需要持久化的模块通过用户提供的 GitHub 用户名和 token 访问其 `main` 分支，以保存隐私数据并支持跨设备同步。

## 模块目录

| moduleId            | 用途               | 状态   | 是否持久化 | 长期文档                           |
| ------------------- | ------------------ | ------ | ---------- | ---------------------------------- |
| `mind-maps`         | 绘制和管理思维导图 | 已实现 | 是         | [Mind Map](./.agents/mind-maps.md) |
| `fragment-thoughts` | 记录碎片想法       | 待重写 | 待重新确认 | 重写前由用户确认业务规则           |

简单模块可以不建立专用文档；需要长期维护说明的模块只维护一份长期文档。

模块文档首先记录模块自身的业务规则、用户操作和代码结构；使用持久化 SDK 时，再记录本模块具体的 payload、event、历史容量、hooks 和远端编码，不重复公共 SDK 原理。

## 任务路由

| 任务 | 必须阅读 |
| --- | --- |
| 维护持久化模块 | [持久化模块公共契约](./.agents/persistent-module-contract.md)；该模块的长期文档（如果存在） |
| 创建持久化模块，或重做 SDK 接线 | [持久化模块公共契约](./.agents/persistent-module-contract.md)；[新持久化模块接入指南](./.agents/new-persistent-module-guide.md)  |
| 开发不持久化模块 | 该模块的长期文档（如果存在） |
| 修改 `src/shared`、首页认证、持久化或同步基础设施 | 先获得用户明确允许；再读 [持久化模块公共契约](./.agents/persistent-module-contract.md) 和 [Shared 维护](./.agents/shared-maintenance.md) |

## 验证

Agent 运行 [README.md](./README.md) 中的测试和构建命令。实际页面的呈现和交互体验由用户验收。

## 最高级规则

- 需要保存业务数据的模块必须使用 `src/shared` 根入口提供的 SDK；不保存数据的模块不要求使用。
- 未经用户明确允许，不得修改 Shared，也不得访问、修改或迁移真实 `my-dashboard-data` 数据。
- token 不得进入 DOM、日志、错误文本、业务 payload 或 event 历史。
