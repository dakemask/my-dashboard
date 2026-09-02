# Home

## 定位

Home 是项目根页面，负责展示业务模块入口，并管理整个 Dashboard 当前使用的本地模式或 GitHub 账户。它不拥有业务 payload，也不启动一套自己的模块运行时；业务数据仍由各模块和 Shared 处理。Home 只在账户边界直接调用 Shared 的认证、profile、本地存储、远端仓库和同步能力，其中最重要的特殊职责是首次添加账户时接管全部持久化模块。

主要调用关系是：

```text
index.html → main.ts → HomeApp
                         ├─ createHomePage ← profile 状态 + 模块目录
                         └─ AccountSettingsDialog
                              ├─ 切换账户 → DashboardProfileStore
                              └─ 添加账户 → GitHub 认证
                                             ├─ 已有账户：登记并切换
                                             └─ 本地模式：全模块预检与首次接管
```

## 模块目录与首页呈现

`dashboardModuleCatalog` 是首页模块卡片和首次账户接管共用的唯一目录。每个条目包含页面路由、标题、简介，以及持久化模块可选的 `ModuleDefinition`。当前目录包含 Todos、Mind Maps 和 Fragment Thoughts。

目录产生两份投影：`dashboardModules` 提供页面卡片及 `modules/<routeSlug>/` 链接；`persistentDashboardDefinitions` 提供首次账户流程需要检查和迁移的持久化模块定义。路由名负责页面位置，definition 的 `moduleId` 负责本地与远端数据身份；标题查询同时接受这两种标识。

`HomeApp` 每次渲染时读取 profile 状态，再把状态和模块卡片交给纯 DOM 视图 `createHomePage`。页面只展示当前模式、模块入口和账户设置按钮。账户设置完成或账户切换后，Home 会重建页面；新选择的 profile 会在之后打开业务模块时由 Shared 运行时读取。

## 账户与 profile

没有账户记录时，Dashboard 使用固定的 `local` profile，模块只访问该 profile 的 IndexedDB，不连接云端。添加账户后，profile store 在 localStorage 中保存账户凭据、账户列表和当前账户；每个账户使用独立 profile id，因此各账户与本地模式的模块缓存和编辑租约互相隔离。GitHub profile id 由规范化后的用户名稳定生成，形式为 `github-<lowercase-username>`。

账户设置对已有账户的切换只是更新当前账户，不读取或改写模块数据，也不立即访问 GitHub。后续进入模块时，模块运行时使用新的活动 profile；若该账户尚无对应模块的本机记录，运行时会从云端建立记录。

添加账户首先校验用户名和 token 所属身份一致，并确认固定的私有仓库 `my-dashboard-data` 属于该用户、token 具有读写权限且 `main` 分支存在。已有账户模式下，验证成功后直接登记并切换到新账户；跨模块数据接管只发生在从本地模式添加首个账户时。

## 首个账户接管

首次接管是一条 Dashboard 级流程，而不是三个模块各自执行的登录流程。

1. `inspectFirstAccount` 对目录中的全部持久化模块执行只读预检。每个模块同时读取 `local` profile 与云端数据，按当前 definition 完成 schema 迁移、payload 校验、内容哈希和相对空 payload 的语义数据判断。任一模块的本地完整性、schema、远端清单或业务数据无效，都会使整个预检在写入开始前失败。
2. 方向由所有模块的汇总结果决定。本地与云端都存在业务数据时，用户选择“本地覆盖云端”或“云端覆盖本地”；只有本地存在数据时自动采用本地方向，其余情况采用云端方向。一个方向统一应用于全部持久化模块，不逐模块选择。
3. 用户确认后，`bindFirstAccount` 会重新执行完整只读预检。只有这次预检全部成功，才开始建立目标账户 profile，避免依据较早的检查结果直接写入。
4. 本地方向会把各模块的本地模式 payload 建入目标账户缓存，再通过 `SyncCoordinator` 覆盖该模块当前云端版本。云端方向会让目标账户缓存以当前云端 payload 为准。模块依次接管，但各自仍使用正常的 definition、迁移、IndexedDB envelope 和远端 revision 协议。
5. 全部模块完成后，Home 才把账户写入 profile store 并设为当前账户；随后删除已被接管的 `local` profile 模块数据库。

首次流程没有跨 IndexedDB 与 GitHub 的全局事务。任何失败都会清理尚未登记账户的模块缓存并保留本地模式；但本地方向一旦开始写云端，先完成的模块无法自动回滚。错误会记录“云端可能已部分更新”，界面要求保持本地方向重试，使重复执行继续收敛到同一结果。账户登记失败也遵守相同清理边界，只有账户成功保存后才清理 `local` profile。

## 账户设置交互

`AccountSettingsDialog` 使用一个原生 dialog 和显式状态机承载 `overview`、`add-form`、`direction-choice`、`busy` 与 `error`。Dialog 只负责表单、焦点、取消和状态呈现；认证、预检、接管和 profile 写入由 `HomeApp` 编排。

异步阶段进入 `busy` 后不能关闭对话框。用户名会在失败后保留以便重试，token 输入在提交、返回或关闭时立即清空；只有认证与账户流程全部成功后，凭据才由 profile store 持久化。账户变化后，对话框关闭并触发首页重绘，焦点回到新页面的账户设置按钮。

## 代码定位

| 内容 | 主要实现 |
| --- | --- |
| 根页面入口与样式 | `index.html`、`src/home/main.ts`、`src/home/style.css` |
| 模块目录及两类投影 | `src/home/modules.ts` |
| 首页与账户流程编排 | `src/home/app/HomeApp.ts` |
| 首页 DOM 与账户设置状态机 | `src/home/ui/HomePage.ts`、`src/home/ui/AccountSettingsDialog.ts` |
| 首次账户预检、接管与清理 | `src/home/firstAccountSetup.ts` |
| 首次账户兼容导出 | `src/home/accountSetup.ts` |
| 账户持久化与认证 | `src/shared/profiles/`、`src/shared/auth/` |
| 接管复用的模块存储与同步能力 | `src/shared/persistence/`、`src/shared/github/`、`src/shared/sync/` |