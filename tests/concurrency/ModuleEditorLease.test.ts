import { describe, expect, it } from "vitest";

import { ModuleEditorLease } from "../../src/shared/concurrency";

interface LockRequest {
  readonly name: string;
  readonly options: LockOptions;
}

class FakeLockManager {
  readonly requests: LockRequest[] = [];
  readonly #held = new Set<string>();

  async request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void> | void,
  ): Promise<void> {
    this.requests.push({ name, options });
    if (options.ifAvailable && this.#held.has(name)) {
      await callback(null);
      return;
    }

    this.#held.add(name);
    try {
      await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      this.#held.delete(name);
    }
  }
}

describe("ModuleEditorLease", () => {
  it("blocks a second tab for the same module and allows other modules", async () => {
    const manager = new FakeLockManager();
    const locks = manager as unknown as LockManager;
    const first = new ModuleEditorLease("mind-maps", { lockManager: locks });
    const second = new ModuleEditorLease("mind-maps", { lockManager: locks });
    const otherModule = new ModuleEditorLease("notes", { lockManager: locks });

    await expect(first.acquire()).resolves.toBe("acquired");
    await expect(second.acquire()).resolves.toBe("blocked");
    await expect(otherModule.acquire()).resolves.toBe("acquired");
    expect(first.editable).toBe(true);
    expect(second.editable).toBe(false);
    expect(manager.requests[0]).toMatchObject({
      name: "my-dashboard.module.mind-maps.editor",
      options: { mode: "exclusive", ifAvailable: true },
    });

    await first.release();
    await otherModule.release();
  });

  it("releases the lock for a later tab", async () => {
    const manager = new FakeLockManager();
    const locks = manager as unknown as LockManager;
    const first = new ModuleEditorLease("mind-maps", { lockManager: locks });
    await first.acquire();
    await first.release();
    expect(first.status).toBe("released");

    const later = new ModuleEditorLease("mind-maps", { lockManager: locks });
    await expect(later.acquire()).resolves.toBe("acquired");
    await later.release();
  });

  it("allows the same module to be edited under different profiles", async () => {
    const manager = new FakeLockManager();
    const locks = manager as unknown as LockManager;
    const local = new ModuleEditorLease("mind-maps", {
      lockManager: locks,
      profileId: "local",
    });
    const account = new ModuleEditorLease("mind-maps", {
      lockManager: locks,
      profileId: "github-octocat",
    });

    await expect(local.acquire()).resolves.toBe("acquired");
    await expect(account.acquire()).resolves.toBe("acquired");
    expect(manager.requests.map((request) => request.name)).toEqual([
      "my-dashboard.module.local.mind-maps.editor",
      "my-dashboard.module.github-octocat.mind-maps.editor",
    ]);

    await local.release();
    await account.release();
  });

  it("forbids editing when Web Locks are unavailable", async () => {
    const lease = new ModuleEditorLease("mind-maps", { lockManager: null });
    await expect(lease.acquire()).resolves.toBe("unsupported");
    expect(lease.editable).toBe(false);
  });

  it("rejects module identifiers that begin with a number", () => {
    expect(() => new ModuleEditorLease("1-notes", { lockManager: null })).toThrow(TypeError);
  });
});
