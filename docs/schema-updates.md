# 持久化模块 schema 更新

## schema 与版本

模块的 payload 类型、校验器和远端编解码共同描述持久化数据。`definition.migration.currentVersion` 标记当前代码生成并接受的 schema 版本；本地记录和云端 `revision.json` 分别保存各自数据的 `schemaVersion`。

只有持久化结构或语义发生变化、已有数据需要转换时才升级版本。页面状态、控制器流程或不改变 payload 结果的事件调整不属于 schema 更新。

## 修改范围

一次 schema 更新需要同步修改所有直接依赖该结构的模块代码：

- payload 类型和空数据创建函数；
- 整体 payload 校验与规范化；
- 读取或生成该结构的业务事件；
- 远端文件的 `encode` 与 `decode`；
- 模块定义中的当前版本和迁移函数；
- 模块文档中的“核心模型”。

## 迁移链

`migration.migrate(value, fromVersion)` 只负责从 `fromVersion` 转换到下一个版本。Shared 会从数据声明的版本开始重复调用，直到 `currentVersion`，然后才使用当前校验器验证结果。因此每个仍可能出现在本地或云端的数据版本都要保留对应的单步迁移：

```ts
migration: {
  currentVersion: 3,
  migrate(value, fromVersion) {
    switch (fromVersion) {
      case 1:
        return migrateV1ToV2(value);
      case 2:
        return migrateV2ToV3(value);
      default:
        throw new TypeError(`Unsupported source schema version: ${fromVersion}`);
    }
  },
},
```

迁移输入是未通过当前 schema 校验的旧数据，迁移函数不能把它当作当前 `Payload`。每一步返回新的 JSON 兼容值，不修改输入，也不读取页面状态、时间、网络或其他外部状态。迁移只转换既有业务数据，不引入一次普通用户编辑。

版本化模块只接受显式、有效的源版本。Shared 不推测缺失版本的数据属于哪个旧 schema，也不打开高于当前版本的数据。

## 远端格式

云端数据先由 `decode` 从受管文件还原，再按 `schemaVersion` 迁移。`decode` 不接收版本号，因此远端文件布局或字段格式发生变化时，它需要识别仍受支持的旧格式，并返回迁移函数能够处理的原始值；不要在旧数据完成迁移前调用只接受当前结构的校验逻辑。`encode` 只生成当前格式。

## Shared 的处理

Shared 对本地旧数据先完成整条迁移并校验，再以一次原子写入更新 payload、版本和迁移记录，然后才启动模块页面。云端旧数据也使用同一条迁移链。纯 schema 迁移与用户尚未同步的业务修改分别记录；在没有业务修改或冲突时，Shared 可以把迁移后的当前格式自动发布到云端。

模块只提供版本、转换和当前数据定义，不在控制器或页面启动代码中另建迁移流程。
