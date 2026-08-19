# Fragment Thoughts

## 概览

Fragment Thoughts 是用于记录短文本想法的持久化模块。它把每条想法建模为一个稳定实体，把每次有效修改追加为新版本；列表显示最新版本，历史面板展示完整版本序列，搜索同时覆盖当前内容和历史内容。

模块通过 Shared 运行时接入账户、本地持久化、云端同步、冲突处理和页面会话内的撤销重做。Fragment Thoughts 自身负责数据语义、事件、草稿、查询投影和页面交互。远端业务内容编码为 `thoughts.json`。

## 核心模型

当前 schema 版本为 1，业务 payload 的真实结构是：

```ts
interface FragmentThoughtsPayload {
  readonly thoughts: readonly FragmentThought[];
}

interface FragmentThought {
  readonly id: string;
  readonly versions: readonly FragmentThoughtVersion[];
  readonly collapsedVersionIds: readonly string[];
}

interface FragmentThoughtVersion {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
}
```

最后一个 version 是想法的当前内容，因此当前内容不是一份与历史并列维护的重复状态。

编辑只追加版本，不覆盖旧版本；`collapsedVersionIds` 只记录历史面板的持久化折叠选择，不参与当前版本判断。domain 统一保证实体标识、版本顺序和文本有效性。payload 中的数组顺序不表达页面顺序，列表由投影层按当前版本时间生成。

## 事件模型

所有持久化变化都表示为可逆事件。事件共有五种：

- `insert-thought { thought }`：加入一条带首个版本的想法。
- `delete-thought { thoughtId }`：删除整条想法及其全部版本。
- `append-version { thoughtId, version, collapsed }`：追加版本，并记录其初始折叠状态。
- `remove-last-version { thoughtId, versionId }`：移除指定的最后版本。
- `set-version-collapsed { thoughtId, versionId, collapsed }`：改变版本的折叠状态。

这些事件都能由变更前后的 payload 生成逆事件。Shared 在容量为 100 的单一页面会话历史中应用它们；业务事件先更新运行时 payload，再由控制器请求本地保存，保存失败不会回退已经进入页面状态的变化。

## 草稿提交协议

草稿独立于持久化 payload，只有完成提交后才转成业务事件。草稿状态有三种：

- `idle`：没有活动草稿。
- `composer`：正在新增，保存输入值和空白校验结果。
- `editing`：正在编辑一条已有想法，保存 thought ID、开始编辑时的原文、当前输入值和空白校验结果。

同一时刻只有一个活动草稿。活动草稿会阻止其他数据修改、同步和撤销重做。结算结果为 `no-change`、`invalid`、`discarded` 或 `ready`；`ready` 产生业务事件，并在事件确实进入 payload 后再清除对应草稿。

Shared 检测到远端 revision 变化时会调用模块的 settle hook。Fragment Thoughts 会在冲突判断前尝试结算活动草稿：有效新增或编辑先转为本地业务事件；空白草稿或已失去目标的编辑结束而不产生事件。随后运行时基于已经包含这次结算结果的 payload 判断本地变化和云端冲突。

## 查询与版本展示

搜索由纯投影层完成，不修改 payload。当前版本或任一历史版本命中都会保留该想法，筛选、高亮和历史命中数量共用同一份匹配结果。搜索期间命中的历史版本会临时展开；搜索词、历史选择和临时展开均为页面期状态，清除搜索后重新使用持久化折叠状态。

## 页面编排

`FragmentThoughtsController` 汇合 payload、Shared 快照、草稿、搜索和历史选择，把 DOM 回调转换为草稿变化或业务事件。

## 代码入口

- `src/fragment-thoughts/definition.ts`：模块定义。
- `src/fragment-thoughts/domain/`：payload、领域规则、事件和编解码。
- `src/fragment-thoughts/app/`：页面编排、草稿与投影逻辑。
- `src/fragment-thoughts/ui/`：页面骨架、列表、历史与反馈组件。
