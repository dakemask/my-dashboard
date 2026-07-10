// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { OperationGate } from "../../src/shared/concurrency";
import {
  DomOperationGatePresentation,
  renderModuleEditorBlockPage,
} from "../../src/shared/ui";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("DomOperationGatePresentation", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("silently makes the app inert during a local save", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const gate = new OperationGate(new DomOperationGatePresentation(root));
    const work = deferred<void>();

    const saving = gate.runLocal(() => work.promise);
    await Promise.resolve();
    expect(root.inert).toBe(true);
    expect(root.dataset.persistenceOperation).toBe("local");
    expect(document.querySelector("[data-operation-gate-overlay]")).toBeNull();

    work.resolve(undefined);
    await saving;
    expect(root.inert).toBe(false);
    expect(root.hasAttribute("data-persistence-operation")).toBe(false);
  });

  it("shows a cloud spinner/blur overlay and always removes it after failure", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const gate = new OperationGate(new DomOperationGatePresentation(root));
    const work = deferred<void>();

    const uploading = gate.runCloud(() => work.promise);
    await Promise.resolve();
    const overlay = document.querySelector<HTMLElement>(
      '[data-operation-gate-overlay="cloud"]',
    );
    expect(root.inert).toBe(true);
    expect(root.classList.contains("shared-cloud-operation-active")).toBe(true);
    expect(overlay?.getAttribute("role")).toBe("status");
    expect(overlay?.querySelector(".shared-cloud-operation-spinner")).not.toBeNull();

    work.reject(new Error("upload failed"));
    await expect(uploading).rejects.toThrow("upload failed");
    expect(root.inert).toBe(false);
    expect(root.classList.contains("shared-cloud-operation-active")).toBe(false);
    expect(document.querySelector("[data-operation-gate-overlay]")).toBeNull();
  });

  it("renders only the appropriate blocking page without a lease", () => {
    const root = document.createElement("div");
    root.append(document.createElement("button"));
    document.body.append(root);

    const blocked = renderModuleEditorBlockPage(root, "blocked");
    expect(root.children).toHaveLength(1);
    expect(blocked.dataset.editorBlockReason).toBe("blocked");
    expect(blocked.textContent).toContain("另一个标签页");

    const unsupported = renderModuleEditorBlockPage(root, "unsupported");
    expect(root.children).toHaveLength(1);
    expect(unsupported.textContent).toContain("不支持安全的单模块编辑锁");
  });
});
