# my-dashboard

一个基于 GitHub Pages 的个人仪表盘框架。项目使用 TypeScript + Vite 构建，GitHub Actions 会把构建产物部署到 GitHub Pages。

## 本地开发

```bash
npm install
npm run dev
```

## 模块开发文档

业务模块开发 agent 按顺序阅读：

1. [通用模块约束](./docs/general-module-constraints.md)
2. [Shared 模块 SDK 使用指南](./docs/shared-module-sdk-guide.md)
3. 当前模块设计，例如 [Mind Map 专用设计](./docs/mindmap-greenfield-architecture.md)

只有维护 Shared、认证或同步基础设施时才阅读 [Shared 与平台内部规范](./docs/shared-platform-internals.md)。业务模块只从 `src/shared` 根入口使用模块 SDK，不直接依赖内部目录。

## 测试

```bash
npm test
```

## 构建

```bash
npm run build
```

构建产物会生成在 `dist/`，这个目录不需要提交到仓库。

## GitHub Pages 部署

仓库保留源码，GitHub Actions 在每次推送到 `main` 分支时执行构建，并把 `dist/` 作为 Pages artifact 部署。也可以在 GitHub 网页的 Actions 页面手动运行 `Deploy GitHub Pages` workflow。

第一次切换到 workflow 部署时，需要在 GitHub 仓库页面操作：

1. 打开 `Settings -> Pages`。
2. 在 `Build and deployment` 里把 `Source` 改成 `GitHub Actions`。
3. 推送代码到 `main`，或打开 `Actions -> Deploy GitHub Pages -> Run workflow` 手动运行。
4. workflow 成功后，页面会发布到仓库对应的 GitHub Pages 地址。
