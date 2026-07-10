import type { ModuleEditorLeaseStatus } from "../concurrency/ModuleEditorLease";

export type ModuleEditorBlockReason = Extract<
  ModuleEditorLeaseStatus,
  "blocked" | "unsupported"
>;

/** Replaces the application content with the only page allowed without a lease. */
export function renderModuleEditorBlockPage(
  appRoot: HTMLElement,
  reason: ModuleEditorBlockReason,
): HTMLElement {
  const document = appRoot.ownerDocument;
  const page = document.createElement("main");
  page.className = "shared-module-editor-block-page";
  page.dataset.editorBlockReason = reason;

  const title = document.createElement("h1");
  title.textContent = "此模块当前不可编辑";
  const detail = document.createElement("p");
  detail.textContent =
    reason === "blocked"
      ? "同一模块已在另一个标签页中打开，请关闭该标签页后重试。"
      : "当前浏览器不支持安全的单模块编辑锁，因此已禁止编辑。";

  page.append(title, detail);
  appRoot.inert = false;
  appRoot.replaceChildren(page);
  return page;
}
