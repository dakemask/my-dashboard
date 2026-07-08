# DOM + SVG 思维导图需求规格

## 目标

用 HTML DOM 节点和 SVG 箭头实现思维导图编辑器。交互目标接近 PowerPoint 文本框：文字编辑、对象选中、缩放、移动、画箭头、删除、平移、缩放、撤销重做和保存都要边界清晰，但操作上尽量无感。

不要使用 Canvas 或 Konva。文本框应是真实 DOM 元素，箭头应使用 SVG。

## 现有项目边界

保留现有路由和模块外壳：

- 路由：`/modules/mind-map/`
- HTML 外壳：`modules/mind-map/index.html`
- 页面控制器：`src/mind-map/main.ts`
- DOM 查询和工具栏辅助：`src/mind-map/view.ts`
- 数据和领域逻辑：`src/mind-map/mindMap.ts`
- 持久化：`src/mind-map/mindMapRepository.ts`
- 类型定义：`src/mind-map/types.ts`

当前视图实现入口：

- `src/mind-map/domSvgMapView.ts`

这个文件目前只是可构建骨架。请在这里实现真正的 DOM + SVG 编辑器；如果实现开始混合太多职责，再拆出更小的文件。

## 公开视图 API

`main.ts` 当前期望 `MindMapView` 提供这些方法：

```ts
render(data: MindMapData, selection: MindMapSelection): void;
setConnectMode(enabled: boolean): void;
getNewNodePosition(): { x: number; y: number };
resetView(): void;
commitActiveEdit(): void;
editNodeText(id: string): void;
destroy(): void;
```

构造方式：

```ts
new MindMapView(elements.mapHost, {
  onSelectionChange,
  onNodeFrameChange,
  onNodeTextChange,
  onArrowCreate,
  onContextMenu,
});
```

优先保持这个 API。只有当视图和控制器的契约调整能明显简化实现时，才同步修改 `main.ts`。

## 数据模型

持久化数据结构必须保持兼容：

```ts
interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MindMapArrow {
  id: string;
  from: { nodeId: string; side: "top" | "right" | "bottom" | "left" };
  to: { nodeId: string; side: "top" | "right" | "bottom" | "left" };
}
```

未经用户确认，不要修改持久化 JSON 形状。

## 渲染架构

使用一个全屏宿主元素：

```html
<div id="mapHost" class="map-host"></div>
```

推荐内部结构：

```html
<div class="mind-map-viewport">
  <svg class="mind-map-arrows"></svg>
  <div class="mind-map-node">
    <div class="mind-map-node-text" contenteditable="plaintext-only"></div>
    <button class="mind-map-handle mind-map-handle-bottom-right"></button>
  </div>
</div>
```

使用 CSS transform 实现平移和缩放：

```css
.mind-map-viewport {
  transform: translate(var(--pan-x), var(--pan-y)) scale(var(--scale));
  transform-origin: 0 0;
}
```

节点位置以世界坐标持久化。鼠标屏幕坐标需要根据当前平移和缩放转换成世界坐标。

## 文本框交互

状态：

- 未选中：细边框，无缩放控制点。
- 对象选中：显示选中边框和缩放控制点。
- 文本编辑中：保留同样的选中框和缩放控制点；文字光标和选区使用浏览器原生能力。

规则：

- 点击文字区域进入编辑，并把光标放到点击位置。
- 在文字区域按下并拖动应立即框选文字，即使松开时指针已经离开节点范围。
- 对象选中时按 `Enter` 进入文本编辑。
- 编辑中按 `Esc` 提交文字并回到对象选中状态。
- 编辑中按 `Delete` 只删除文字，不删除节点。
- 对象选中时按 `Delete` 删除整个节点。
- `Ctrl+S` 先提交当前编辑，再保存。
- 文本编辑中 `Ctrl+Z/Y` 优先使用浏览器原生文字撤销/重做。
- 非文本编辑中 `Ctrl+Z/Y` 使用模块级撤销/重做栈。

显示和编辑应使用同一个真实 DOM 可编辑元素。不要再使用“单独视觉文字层 + 透明编辑层”的双系统方案。

推荐：

```html
<div contenteditable="plaintext-only"></div>
```

如果浏览器对 `plaintext-only` 支持不足，则使用 `contenteditable="true"`，并在粘贴或输入时清洗成纯文本。

## 自动尺寸规则

宽度：

- 初始创建后，节点宽度主要由用户缩放决定。
- 新建空白节点首次输入时，可以根据文本自然宽度初始化，最大不超过默认宽度。
- 节点已有内容或被用户缩放后，不要因为文字变短而自动缩窄宽度。

高度：

- 文本输入和缩放提交后，高度应适配文字行数。
- 缩放拖动过程中，视觉框可以小于文字所需面积。
- 当视觉框过小时，文字仍应像 PowerPoint 一样继续显示到框外，不要裁切。

最小值：

- 缩放拖动过程中，框可以缩到接近一条线或一个点。
- 不实现 PowerPoint 的形状翻转。
- 如果指针越过对边，视觉宽高应钳制到接近 0，而不是反向。
- 松开后，如果宽度接近 0，应归一化到约一个中文字宽加内边距。
- 松开后，高度应归一化到能容纳文字。

尺寸测量使用 DOM 能力，例如 `scrollHeight`、`getBoundingClientRect` 和计算样式。不要再加入 Canvas 文本测量。

## 移动和缩放

控制点：

- 八个缩放控制点：四个角和四条边中点。
- 缩放控制点视觉上应小而轻。
- 使用 Pointer Events（指针事件）和 `setPointerCapture`。
- 在 `pointerdown` 时确定的控制点必须控制整个拖拽过程直到 `pointerup`。
- 拖拽中不要依赖鼠标悬停目标判断当前控制点。

缩放：

- 边中点控制点只改变一个轴。
- 角控制点同时改变两个轴。
- 不锁定宽高比。
- 不旋转。
- 不翻转。
- 缩放过程中箭头端点和连接点要实时更新。

移动：

- 拖动节点边框或文字外的节点主体区域移动节点。
- 点击空白编辑区域取消选中。
- 拖动空白编辑区域平移视图。

## 平移和缩放

- 思维导图编辑区域全屏显示。
- 拖动空白区域平移。
- 鼠标滚轮以指针位置为中心缩放。
- 复位按钮恢复有用视图，最好能适配所有已有节点。
- 如果实现成本不高，网格背景应随平移和缩放保持视觉对齐。

## 箭头

使用 SVG。

规则：

- 只实现直线箭头。
- 箭头起点和终点都是节点四边中点。
- 合法边：`top`、`right`、`bottom`、`left`。
- 连线模式下显示小灰色边中点连接点。
- 点击第一个连接点开始画箭头。
- 点击另一个节点的连接点创建箭头。
- 不允许节点连自己。
- 创建一个箭头后自动退出连线模式。
- 箭头被选中后，可以用 `Delete` 或右键菜单删除。

实现建议：

- 将 SVG 放在和节点相同的已变换视口中，或对 SVG 应用相同 transform。
- 箭头用 `<line>` 或 `<path>`。
- 箭头头部用 SVG `<marker>`。
- 如果线条难以选中，可以增加更宽的透明命中线或命中路径。

## 快捷键

保留当前行为：

- `Alt+1`：创建文本框。
- `Alt+2`：进入连箭头模式。
- `Ctrl+S`：保存。
- `Ctrl+Z`：非文本编辑状态撤销。
- `Ctrl+Y`：非文本编辑状态重做。
- `Enter`：编辑选中的节点。
- `Delete` / `Backspace`：非文本编辑状态删除选中的节点或箭头。

## 右键菜单

- 右键节点或箭头时，选中该对象并打开删除菜单。
- 右键已选中对象时打开删除菜单。
- 文本编辑中右键不应删除对象。
- 右键空白区域应清除或隐藏对象菜单。

## 视觉方向

- 整体感觉应轻、可编辑、接近 PowerPoint。
- 未选中边框要细。
- 选中和编辑态边框/发光要克制。
- 缩放控制点要小。
- 文字内边距要紧凑。
- 连线模式的连接点用小灰点。
- 框太小时文字不能被裁切。
- 避免卡片化装饰、营销式布局、渐变和纯装饰背景。

## 建议文件拆分

可以先在 `domSvgMapView.ts` 中实现。复杂度上来后再按职责拆分：

- `domSvgMapView.ts`：主视图控制器和公开 API。
- `mapViewport.ts`：平移、缩放、坐标转换。
- `nodeDomView.ts`：节点 DOM 创建、编辑状态、移动和缩放控制点。
- `arrowSvgView.ts`：SVG 箭头渲染和连接点命中。
- `mapGeometry.ts`：端点、边界、坐标等纯几何 helper。

持久化和数据归一化不要放进视图层。

## 验收测试

运行：

```bash
npm run build
```

浏览器手动验收：

- 进入 `/modules/mind-map/` 后立即看到编辑器。
- 用工具栏和 `Alt+1` 创建节点。
- 输入短中文、长中文、数字和手动换行。
- 点击文字能把光标放到对应位置。
- 拖动文字能框选，包括松开时指针已经离开节点范围。
- 编辑中 `Delete` 只删除文字。
- `Esc` 提交编辑。
- 对象选中后 `Delete` 删除整个节点。
- 右键选中节点可通过菜单删除。
- 拖动节点可移动。
- 八个缩放控制点都可缩放；拖拽中控制点不能切换。
- 控制点拖过对边时，框压成线/点，不翻转。
- 过小缩放松开后，宽度至少归一化到一个字宽，高度适配文字。
- 缩放中框太小时文字仍显示在框外。
- 拖动空白区域平移视图。
- 鼠标滚轮以指针位置为中心缩放。
- 复位按钮可用。
- 用工具栏和 `Alt+2` 进入连箭头模式。
- 能从任意边中点连接到另一个节点的任意边中点。
- 节点移动或缩放后箭头同步更新。
- 创建箭头后自动退出连线模式。
- 箭头可用 `Delete` 和右键菜单删除。
- `Ctrl+S`、`Ctrl+Z`、`Ctrl+Y` 在文本编辑边界下行为正确。
