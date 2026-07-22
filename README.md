# my-dashboard

一个基于 GitHub Pages 的个人仪表盘框架。项目使用 TypeScript + Vite 构建，GitHub Actions 会把构建产物部署到 GitHub Pages。

## 本地开发

```bash
npm install
npm run dev
```

## Agent 开发文档

[AGENTS.md](./AGENTS.md) 是唯一入口。它会根据任务把 agent 引导到 `.agents/` 中的持久化公共契约、首次 SDK 接入指南、Shared 维护规范或具体模块契约。

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
