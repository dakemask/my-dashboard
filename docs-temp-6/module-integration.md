# 新增非持久化模块接入

## 代码组成

非持久化模块拥有独立页面，但不接入 Shared 的持久化模块协议、账户数据和云端同步流程。模块可以按实际需求使用浏览器本地能力，业务代码统一放在 `src/<module-id>/`，页面入口放在 `modules/<module-id>/index.html`：

```text
src/<module-id>/
  main.ts
  ...

modules/<module-id>/index.html
```

入口 HTML 挂载 `#app`，加载模块的脚本和样式。模块内部结构由实际功能决定，不需要为了接入项目而创建 `definition.ts`、domain 或 controller。模块目录和首页 `routeSlug` 使用同一个 kebab-case 标识。

## 项目注册

模块代码完成后还需要进入项目的页面和模块目录：

1. 在 `modules/<module-id>/index.html` 建立独立页面并加载模块入口。
2. 在 `vite.config.ts` 的 `build.rollupOptions.input` 中加入该 HTML 页面。
3. 在 `src/home/modules.ts` 的 `dashboardModuleCatalog` 中添加 `routeSlug`、标题和描述，不提供 `definition`。该目录项会显示在首页，但不会进入 `persistentDashboardDefinitions`。
4. 在 `AGENTS.md` 的非持久化模块清单中加入模块概述。
5. 编写对应的 `<module-id>.md` 模块文档，统一包含“概览”和“代码入口”；其余章节只按模块的真实架构和行为添加。
