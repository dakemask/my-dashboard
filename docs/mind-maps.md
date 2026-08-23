# Mind Maps

## 概览

Mind Maps 是一个由“分层资料库”和“空间画布”组成的思维导图模块。资料库负责组织多张脑图，画布负责编辑当前脑图中的节点、虚线框、括号和有向连线。整个模块的业务真值是一个 `MindMapPayload`；当前打开项、选择、视口、编辑草稿等都属于页面期状态，不写入业务数据。

模块通过 `MindMapController` 接入 Shared 运行时。Controller 是业务数据、资料库 UI、画布 UI 和同步 UI 的汇合点，也是 mind-maps 内唯一直接访问 Shared 的类。业务修改先表示为可逆事件，经运行时更新 payload，再投影回资料库和画布；本机保存、撤销重做及云端同步仍由 Shared 提供。

## 核心模型

当前 schema 版本为 3，业务 payload 的真实结构是：

```ts
type ConnectorSide = "top" | "right" | "bottom" | "left";

interface MindMapPayload {
  readonly folders: readonly string[];
  readonly maps: readonly MindMapDocument[];
}

interface MindMapDocument {
  readonly id: string;
  readonly path: string;
  readonly nodes: readonly MindMapNode[];
  readonly boxes: readonly MindMapBox[];
  readonly brackets: readonly MindMapBracket[];
  readonly arrows: readonly MindMapArrow[];
}

interface MindMapNode {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly autoWidth: boolean;
}

interface MindMapBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface MindMapArrow {
  readonly id: string;
  readonly from: MindMapEndpoint;
  readonly to: MindMapEndpoint;
}

interface MindMapBracket {
  readonly id: string;
  readonly from: MindMapPoint;
  readonly to: MindMapPoint;
}

interface MindMapPoint {
  readonly x: number;
  readonly y: number;
}

interface MindMapEndpoint {
  readonly nodeId: string;
  readonly side: ConnectorSide;
}
```

文件夹没有独立对象，其层级由规范化路径推导；脑图用 `path` 同时表达名称和资料库位置，用稳定 `id` 承载页面期引用。因此脑图改名或移动只改变路径。

节点和虚线框都以世界坐标及尺寸持久化；节点尺寸还受文本布局影响，虚线框尺寸完全由右下角缩放手势决定。括号由两个世界坐标端点确定位置、长度和方向；箭头连接两个节点的方位连接点。路径层级、标识、画布对象几何和连线引用等跨对象关系由 domain 统一校验并规范化。

## 资料库与当前脑图

资料库树由路径集合临时构建，不是另一份持久化模型。文件夹的移动、重命名和删除按路径前缀作用于整个子树；资料库命令把这类操作转换为领域事件，并同步调整页面选择与当前脑图。

资料库选择与当前打开的脑图彼此独立，资料库选择和画布选择则互斥，由 Controller 在交互范围切换时统一维护。

侧栏开关、最后打开的脑图和文件夹展开集合保存在 `localStorage` 偏好中，不参与同步、历史和 payload 校验。资料库中的未保存标记则不是独立状态：它由当前 payload 与最近一次成功本机保存的基线比较得到，并向受影响脑图及其祖先文件夹传播。

## 画布的提交数据与临时数据

`MindMapCanvas` 持有当前脑图的页面会话，但不拥有业务真值。选择、每张脑图的视口、箭头模式、文本草稿和手势预览都留在画布会话中，手势完成后才由 Controller 生成领域事件。虚线框内部透明，仅边框参与命中，选中后通过右下角控制点改变尺寸。括号的圆弧、等长短臂和端点控制点均由端点临时推导；直接拖拽会同时选中括号，端点命中区固定对端并改变长度和方向，其余括号命中区平移两个端点。

画布有两种数据更新方式。`project` 用于初始化、切换脑图以及撤销重做等完整投影，会终止临时交互并重建会话状态；`render` 用于当前脑图正常 dispatch 后的增量刷新，会保留仍然有效的选择和编辑上下文。这个区分使运行时投影与普通编辑刷新不共享同一套重置语义。

视口按脑图 ID 保留在当前页面会话中，并负责世界坐标与屏幕坐标转换。节点文本编辑使用独立草稿；提交时文本与测量后的布局进入同一个事件。

## 指针交互状态机

画布的指针手势由 `CanvasInteractionController` 统一管理 pointer capture 和边缘自动平移。状态机包含：

- `idle`：没有捕获中的指针手势。
- `marquee`：框选画布对象。
- `moving`：预览一组节点的统一位移。
- `resizing`：预览单个节点的尺寸变化。
- `adjusting-box`：预览虚线框的平移或右下角缩放。
- `adjusting-bracket`：预览括号的整体平移或单端点调整。
- `connecting`：从起点连接到当前可接受的目标连接点。
- `panning`：根据指针位移更新视口。

这些手势共享边缘自动平移，只在完成时生成业务命令，取消时丢弃预览。箭头模式位于状态机之外，`connecting` 只表示一次已开始的连线手势。

## 事件模型

mind-maps 当前的业务事件分为六组：

- 文件夹：`create-folder { path }`、`delete-folder { path }`、`restore-folder { rootPath, folders, maps }`、`relocate-folder { fromPath, toPath }`。
- 脑图：`create-map { map }`、`delete-map { mapId }`、`restore-map { map }`、`relocate-map { mapId, path }`。
- 节点：`add-node { mapId, node }`、`set-node-text { mapId, nodeId, text, frame, autoWidth }`、`set-node-frame { mapId, nodeId, frame, autoWidth }`、`move-nodes { mapId, positions }`。
- 虚线框：`add-box { mapId, box }`、`set-box { mapId, box }`。
- 括号：`add-bracket { mapId, bracket }`、`set-bracket { mapId, bracket }`。
- 连线与对象集合：`add-arrow { mapId, arrow }`、`delete-objects { mapId, nodeIds, boxIds, bracketIds, arrowIds }`、`restore-objects { mapId, nodes, boxes, brackets, arrows }`。

`applyMindMapEvent` 是事件到新 payload 的唯一领域变换，`invertMindMapEvent` 根据变更前后数据生成逆事件。恢复类事件主要承载删除操作的完整逆数据，例如删除节点时一并消失的关联箭头。模块历史是覆盖整个 payload 的单一页面期历史，容量为 100，不按资料库项目或脑图拆分。

Controller dispatch 后立即刷新界面并合并触发本机保存，最近一次成功保存的 payload 成为本机基线。Shared 执行动作前通过 `settle` 收束资料库内联草稿或节点文本草稿，使其先转成领域事件。

## 文件化表示

远端编码不是把整个 payload 写进一个 JSON。每张脑图编码为 `<脑图路径>.json`，文件正文只保存脑图 ID、节点、虚线框、括号和箭头，路径由文件名提供。文件夹结构主要由这些文件的父路径重建；没有子项的叶子文件夹使用空 `.gitkeep` 表示。解码时会补齐祖先文件夹，再由统一 payload 校验恢复内存模型。

## 代码入口

- `src/mind-maps/definition.ts`：模块定义。
- `src/mind-maps/domain/`：payload、领域规则、事件和编解码。
- `src/mind-maps/app/`：页面编排及 UI 意图到领域事件的转换。
- `src/mind-maps/library/`：资料库树与交互。
- `src/mind-maps/canvas/`：画布会话、状态机、几何和渲染。
- `src/mind-maps/ui/`：页面壳与反馈组件。
