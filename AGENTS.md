# my-dashboard

## 项目说明

这是一个由多个独立模块组成的个人仪表盘。当前仓库已实现 `mind-maps`（绘制和管理思维导图）；`fragment-thoughts`（记录碎片想法）尚未重新实现，不能把它当作现有模块或推测它的业务规则。

源代码位于公开 GitHub 仓库 `my-dashboard`。推送到 `main` 后，GitHub Actions 会测试、构建并部署到 GitHub Pages，供外部访问。

部分模块需要保存业务数据。这些数据位于用户的私有仓库 `my-dashboard-data` 的 `main` 分支，页面通过用户提供的 GitHub 用户名和 token 访问，从而兼顾隐私和跨设备同步。agent 未得到用户明确允许时，不得访问、修改或迁移真实私有仓库数据。

## 按任务选择文档

- 维护已有持久化模块：阅读 [持久化模块公共契约](./.agents/persistent-module-contract.md) 和该模块自己的契约。
- 首次开发持久化模块或重做 SDK 接线：再阅读 [新持久化模块接入指南](./.agents/new-persistent-module-guide.md)。该指南只用于接入阶段，接入完成后不再是日常必读文档。
- 开发不保存业务数据的模块：不要求使用持久化 SDK，也不必阅读持久化文档；只遵守该模块自己的契约和项目公共工程边界。
- 修改 `src/shared`、首页认证、持久化或同步基础设施：必须先获得用户明确允许，再阅读 [Shared 与平台维护规范](./.agents/shared-maintenance.md)。不得把修改 Shared 当作业务模块开发中的顺手重构。

## 持久化模块边界

需要保存业务数据的模块必须使用 `src/shared` 根入口提供的 SDK，并遵守 [持久化模块公共契约](./.agents/persistent-module-contract.md)。模块不得自行实现凭据读取、IndexedDB、GitHub 同步、轮询、编辑锁或云端操作遮罩。

不需要保存业务数据的模块不得为了形式统一而接入这套 SDK。

每个模块只保留一份长期模块契约 `.agents/<module-id>.md`，内容依次覆盖：范围与入口、持久化定义、领域规则、实时/UI 交互、命令与快捷键、明确不支持的行为、验收要求。模块文档只记录模块特有决定，不重复 Shared 公共算法。后续新模块不需要另建“一次性从零开发指导文档”。

## 模块文档

- [Mind Map 模块契约](./.agents/mind-maps.md)
- `fragment-thoughts`：尚未实现；开始开发并确认业务规则后再建立 `.agents/fragment-thoughts.md`。

## 工程入口

- 本地命令、构建和部署说明见 [README.md](./README.md)。
- 测试必须使用 fake 或注入边界，不得连接真实 GitHub 数据仓库。
