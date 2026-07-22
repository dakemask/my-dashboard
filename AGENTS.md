# my-dashboard

## 项目与仓库

本项目是由多个独立模块组成的个人仪表盘。

- `my-dashboard` 是公开源码仓库。推送到 `main` 后，GitHub Actions 自动测试、构建并部署到 GitHub Pages。
- `my-dashboard-data` 是私人数据仓库。需要持久化的模块通过用户提供的 GitHub 用户名和 token 访问其 `main` 分支，以保存隐私数据并支持跨设备同步。
- 本地开发、测试、构建和部署命令见 [README.md](./README.md)。

## 模块目录

| moduleId | 用途 | 状态 | 是否持久化 | 长期文档 |
| --- | --- | --- | --- | --- |
| `mind-maps` | 绘制和管理思维导图 | 已实现 | 是 | [Mind Map](./.agents/mind-maps.md) |
| `fragment-thoughts` | 记录碎片想法 | 待重写 | 待重新确认 | 尚未建立；不得推测其业务规则 |

简单模块不因形式要求强制建立专用文档。需要长期维护说明的模块只建立一份模块文档，不再为每个模块另写一次性的“从零开发指导文档”。

## 任务路由

| 任务 | 必须阅读 |
| --- | --- |
| 维护已有持久化模块 | [持久化模块公共契约](./.agents/persistent-module-contract.md)；该模块的长期文档 |
| 首次创建持久化模块，或重做其 SDK 接线 | 上一项；另读 [新持久化模块接入指南](./.agents/new-persistent-module-guide.md) |
| 维护 Mind Map | [持久化模块公共契约](./.agents/persistent-module-contract.md)；[Mind Map](./.agents/mind-maps.md) |
| 开发不持久化的模块 | 该模块的长期文档（如果存在）；无需阅读或接入持久化 SDK |
| 修改 `src/shared`、首页认证、持久化或同步基础设施 | 先获得用户明确允许；再读 [持久化模块公共契约](./.agents/persistent-module-contract.md) 和 [Shared 维护](./.agents/shared-maintenance.md) |

新持久化模块的接入指南只在初次接入阶段使用；已有模块的日常维护不读它。

## 最高级规则

- 需要保存业务数据的模块必须使用 `src/shared` 根入口提供的 SDK；不保存数据的模块不要求使用。
- 未经用户明确允许，不得修改 Shared，也不得访问、修改或迁移真实 `my-dashboard-data` 数据。
- token 不得进入 DOM、日志、错误文本、业务 payload 或 event 历史。
- 测试必须注入 fake GitHub 请求，不得连接真实私人仓库。
