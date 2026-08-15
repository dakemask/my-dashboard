# my-dashboard 文档架构一比一示例

这个目录不是对现有文档的修改，而是一套可以直接审阅的未来结构样稿。真正拟议的仓库根目录放在 `repository-root/` 中；其中的文件名、相对链接、阅读路由和文档分工都按实际采用时的形态编写。

示例刻意做到三件事：

1. `AGENTS.md` 只保存每次任务都值得加载的项目规则；
2. 产品行为、持久化决定、平台内部约束、全局 UI 规范和少见操作手册分别存放；
3. 每份文档都写明“何时读”和“何时不要读”，避免 AI 因为一个模块使用持久化，就读取所有同步资料。

## 示例目录

```text
repository-root/
├─ AGENTS.md
└─ .agents/
   ├─ documentation-policy.md
   ├─ conventions/
   │  ├─ ui.md
   │  └─ verification.md
   ├─ contracts/
   │  └─ persistent-module.md
   ├─ platform/
   │  └─ shared.md
   ├─ modules/
   │  ├─ mind-maps/
   │  │  ├─ product.md
   │  │  └─ persistence.md
   │  ├─ fragment-thoughts/
   │  │  ├─ product.md
   │  │  └─ persistence.md
   │  └─ todos/
   │     ├─ product.md
   │     └─ persistence.md
   └─ playbooks/
      ├─ new-persistent-module.md
      ├─ schema-migration.md
      └─ large-file-refactor.md
```

现有面向使用者的 `README.md` 和 `DEVELOPMENT.md` 已经很短，因此没有在示例中重写。它们仍应留在真实仓库根目录，但不承担 AI 内部契约的职责。

## 怎样阅读这个示例

建议先看以下几份：

1. `repository-root/AGENTS.md`：观察一个小任务究竟会被路由到哪些文档；
2. 任一模块的 `product.md`：观察如何只描述用户真正关心的行为；
3. 同一模块的 `persistence.md`：观察技术边界如何从产品说明中拆出；
4. `contracts/persistent-module.md`：观察公共契约保留哪些跨模块语义；
5. `platform/shared.md`：观察少见的 Shared 维护资料怎样按内部主题分段，而不是常驻加载。

## 技术占位的写法

示例中的 `[技术占位：……]` 不是把所有技术内容合并省略。每个占位都位于它最终应该存在的具体章节，例如“迁移函数边界”“本地 CAS”“远端单 commit 上传”或“焦点恢复实现”。这样即使暂时不展开代码细节，也能看出每份文档将来负责什么、不会负责什么。

如果以后正式采用，应当对每个占位单独决定：

- 该知识能从类型、代码或测试快速找到：删除占位，不补正文；
- 该知识是容易被破坏且代码无法说明的技术意图：补成简短不变量；
- 该知识只在极少任务中需要：继续留在相应 playbook，而不是搬回 `AGENTS.md`。
