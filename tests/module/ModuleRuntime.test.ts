// @vitest-environment jsdom

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthService, AuthState } from "../../src/shared/auth";
import {
  defineJsonModule,
  startModuleRuntime,
  type ModuleRuntimeHooks,
} from "../../src/shared";
import type { ModuleRuntimeEnvironment } from "../../src/shared/module/runtime";

interface TestPayload {
  readonly value: string;
}

interface TestEvent {
  readonly type: "set-value";
  readonly value: string;
}

const setValue = (value: string): TestEvent => ({ type: "set-value", value });

const session = {
  credentials: { username: "octocat", token: "secret-token" },
  repository: {
    owner: "octocat",
    repository: "my-dashboard-data",
    branch: "main",
  },
};

class FakeAuthService implements AuthService {
  #state: AuthState;
  readonly #listeners = new Set<(state: AuthState) => void>();

  constructor(authenticated = true) {
    this.#state = authenticated
      ? { status: "authenticated", session }
      : { status: "anonymous" };
  }

  getState(): AuthState {
    return this.#state;
  }

  restore() {
    return this.#state.status === "authenticated" ? this.#state.session : null;
  }

  login = vi.fn(async () => session);

  invalidate(): void {
    this.#state = { status: "anonymous" };
    this.#listeners.forEach((listener) => listener(this.#state));
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

class ThrowingUnsubscribeAuthService extends FakeAuthService {
  override subscribe(listener: (state: AuthState) => void): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      unsubscribe();
      throw new Error("unsubscribe failed");
    };
  }
}

class FakeLockManager {
  readonly #held = new Set<string>();

  async request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void> | void,
  ): Promise<void> {
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

class ManualTimerWindow {
  readonly #tasks = new Map<number, { callback: () => void; delay: number }>();
  #nextId = 1;
  readonly window: Window;

  constructor(baseWindow: Window) {
    this.window = {
      location: baseWindow.location,
      addEventListener: baseWindow.addEventListener.bind(baseWindow),
      removeEventListener: baseWindow.removeEventListener.bind(baseWindow),
      setTimeout: ((callback: TimerHandler, delay = 0) => {
        if (typeof callback !== "function") throw new TypeError("Timer callback must be a function.");
        const id = this.#nextId++;
        this.#tasks.set(id, { callback, delay });
        return id;
      }) as Window["setTimeout"],
      clearTimeout: ((id?: number) => {
        if (id !== undefined) this.#tasks.delete(id);
      }) as Window["clearTimeout"],
    } as unknown as Window;
  }

  get size(): number {
    return this.#tasks.size;
  }

  get nextDelay(): number | null {
    return this.#tasks.values().next().value?.delay ?? null;
  }

  runNext(): void {
    const next = this.#tasks.entries().next().value as
      | [number, { callback: () => void; delay: number }]
      | undefined;
    if (!next) throw new Error("No scheduled timer.");
    this.#tasks.delete(next[0]);
    next[1].callback();
  }
}

type GitHubMode = "ok" | "unauthorized" | "failure";

class EmptyGitHub {
  mode: GitHubMode = "ok";
  #releaseRef: (() => void) | null = null;
  #blockedRef: Promise<void> | null = null;

  blockNextRef(): void {
    this.#blockedRef = new Promise((resolve) => {
      this.#releaseRef = resolve;
    });
  }

  releaseRef(): void {
    this.#releaseRef?.();
    this.#releaseRef = null;
  }

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (this.mode === "unauthorized") {
      return new Response(null, { status: 401 });
    }
    if (this.mode === "failure") {
      return new Response(null, { status: 500 });
    }

    const url = new URL(String(input));
    const endpoint = url.pathname.split("/my-dashboard-data")[1] ?? "";
    const method = init.method ?? "GET";
    if (method === "GET" && endpoint === "/git/ref/heads/main") {
      if (this.#blockedRef) {
        await this.#blockedRef;
        this.#blockedRef = null;
      }
      return Response.json({ object: { sha: "commit-1" } });
    }
    if (method === "GET" && endpoint === "/git/commits/commit-1") {
      return Response.json({ sha: "commit-1", tree: { sha: "tree-1" } });
    }
    if (method === "GET" && endpoint === "/git/trees/tree-1") {
      return Response.json({ sha: "tree-1", truncated: false, tree: [] });
    }
    return new Response(null, { status: 404 });
  });
}

function definition(
  moduleId = "runtime-test",
  capacity: number | "unlimited" = 250,
) {
  return defineJsonModule<TestPayload, TestEvent>({
    moduleId,
    createEmpty: () => ({ value: "A" }),
    validate(value: unknown): TestPayload {
      if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") {
        throw new TypeError("invalid test payload");
      }
      return { value: (value as TestPayload).value };
    },
    history: {
      capacity,
      apply: (_payload, event) => ({ value: event.value }),
      invert: (_event, before) => setValue(before.value),
    },
    encode: (payload) => new Map([["data.json", JSON.stringify(payload)]]),
    decode: (files) => JSON.parse(files.get("data.json") ?? "null") as TestPayload,
  });
}

function createRoot(): HTMLDivElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function createEnvironment(
  authService: FakeAuthService,
  github: EmptyGitHub,
  locks: FakeLockManager | null,
  overrides: Partial<ModuleRuntimeEnvironment> = {},
): ModuleRuntimeEnvironment {
  return {
    authService,
    fetch: github.fetch,
    indexedDB: new IDBFactory(),
    lockManager: locks as unknown as LockManager | null,
    autoStartPolling: false,
    reload: vi.fn(),
    onAuthenticationRequired: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ModuleRuntime", () => {
  it("starts from one public entry and settles an event before direct undo", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const project = vi.fn();
    let pendingEvent: TestEvent | null = null;
    const settle = vi.fn(() => {
      const event = pendingEvent;
      pendingEvent = null;
      return event;
    });
    const hooks: ModuleRuntimeHooks<TestPayload, TestEvent> = { settle, project };
    const result = await startModuleRuntime(
      { definition: definition(), appRoot: createRoot(), hooks },
      createEnvironment(auth, github, new FakeLockManager()),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const { runtime } = result;
    expect(project).toHaveBeenCalledWith({ value: "A" }, "initialize");

    runtime.dispatch(setValue("B"));
    pendingEvent = setValue("C");
    await runtime.undo();
    expect(project).toHaveBeenCalledWith({ value: "B" }, "undo");
    expect(settle).toHaveBeenCalledWith("undo");
    expect(runtime.current).toEqual({ value: "B" });

    pendingEvent = setValue("D");
    await expect(runtime.save()).resolves.toBe("saved");
    expect(settle).toHaveBeenCalledWith("local-save");
    expect(runtime.current).toEqual({ value: "D" });
    expect(runtime.dirty).toBe(false);
    await runtime.dispose();
    expect(runtime.state).toBe("disposed");
  });

  it("does not bind or intercept Ctrl+Z, Ctrl+Y, or Ctrl+S", async () => {
    const result = await startModuleRuntime(
      {
        definition: definition("no-shortcuts-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(new FakeAuthService(), new EmptyGitHub(), new FakeLockManager()),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    result.runtime.dispatch(setValue("B"));
    for (const key of ["z", "y", "s"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(result.runtime.current).toEqual({ value: "B" });
    expect(result.runtime.dirty).toBe(true);
    await result.runtime.dispose();
  });

  it("uses the event capacity selected by the module", async () => {
    const result = await startModuleRuntime(
      {
        definition: definition("custom-capacity-test", 1),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(new FakeAuthService(), new EmptyGitHub(), new FakeLockManager()),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    result.runtime.dispatch(setValue("B"));
    result.runtime.dispatch(setValue("C"));
    await expect(result.runtime.undo()).resolves.toEqual({ value: "B" });
    expect(result.runtime.canUndo).toBe(false);
    await expect(result.runtime.undo()).resolves.toEqual({ value: "B" });
    await result.runtime.dispose();
  });

  it("automatically uses the shared cloud spinner and overlay", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    github.blockNextRef();
    const root = createRoot();
    const started = startModuleRuntime(
      {
        definition: definition("spinner-test"),
        appRoot: root,
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(auth, github, new FakeLockManager()),
    );

    await vi.waitFor(() => {
      expect(document.querySelector('[data-operation-gate-overlay="cloud"]')).not.toBeNull();
    });
    expect(root.inert).toBe(true);
    github.releaseRef();

    const result = await started;
    expect(result.status).toBe("ready");
    expect(document.querySelector('[data-operation-gate-overlay="cloud"]')).toBeNull();
    expect(root.inert).toBe(false);
    if (result.status === "ready") await result.runtime.dispose();
  });

  it("renders a blocker for a second tab and releases the lease on dispose", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const locks = new FakeLockManager();
    const environment = createEnvironment(auth, github, locks);
    const first = await startModuleRuntime(
      {
        definition: definition("lease-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      environment,
    );
    expect(first.status).toBe("ready");

    const blockedRoot = createRoot();
    const second = await startModuleRuntime(
      {
        definition: definition("lease-test"),
        appRoot: blockedRoot,
        hooks: { settle: () => null, project: () => undefined },
      },
      environment,
    );
    expect(second.status).toBe("blocked");
    expect(blockedRoot.querySelector('[data-editor-block-reason="blocked"]')).not.toBeNull();

    if (first.status === "ready") await first.runtime.dispose();
    const third = await startModuleRuntime(
      {
        definition: definition("lease-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      environment,
    );
    expect(third.status).toBe("ready");
    if (third.status === "ready") await third.runtime.dispose();
  });

  it("blocks unsupported browsers before creating module state", async () => {
    const root = createRoot();
    const result = await startModuleRuntime(
      {
        definition: definition("unsupported-test"),
        appRoot: root,
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(new FakeAuthService(), new EmptyGitHub(), null),
    );

    expect(result.status).toBe("unsupported");
    expect(root.querySelector('[data-editor-block-reason="unsupported"]')).not.toBeNull();
  });

  it("returns to the login boundary without exposing authentication to the module", async () => {
    const auth = new FakeAuthService(false);
    const onAuthenticationRequired = vi.fn();
    const github = new EmptyGitHub();
    const result = await startModuleRuntime(
      {
        definition: definition("auth-required-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(auth, github, new FakeLockManager(), { onAuthenticationRequired }),
    );

    expect(result.status).toBe("authentication-required");
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it("cleans up and returns to login when GitHub rejects saved credentials", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const onAuthenticationRequired = vi.fn();
    const result = await startModuleRuntime(
      {
        definition: definition("auth-loss-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(auth, github, new FakeLockManager(), { onAuthenticationRequired }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    github.mode = "unauthorized";
    await expect(result.runtime.upload()).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(result.runtime.state).toBe("disposed"));
    expect(auth.getState().status).toBe("anonymous");
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
  });

  it("starts automatic polling and stops all future polls on dispose", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const timers = new ManualTimerWindow(window);
    const result = await startModuleRuntime(
      {
        definition: definition("automatic-poll-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(auth, github, new FakeLockManager(), {
        autoStartPolling: true,
        random: () => 0,
        window: timers.window,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(github.fetch).toHaveBeenCalledTimes(3);
    expect(timers.nextDelay).toBe(0);

    timers.runNext();
    await vi.waitFor(() => expect(github.fetch).toHaveBeenCalledTimes(6));
    expect(timers.nextDelay).toBe(60_000);
    timers.runNext();
    await vi.waitFor(() => expect(github.fetch).toHaveBeenCalledTimes(9));

    await result.runtime.dispose();
    expect(timers.size).toBe(0);
    expect(github.fetch).toHaveBeenCalledTimes(9);
  });

  it("invalidates authentication when an automatic poll receives a 401", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const onAuthenticationRequired = vi.fn();
    const result = await startModuleRuntime(
      {
        definition: definition("poll-auth-loss-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      createEnvironment(auth, github, new FakeLockManager(), {
        autoStartPolling: true,
        onAuthenticationRequired,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    github.mode = "unauthorized";
    await vi.waitFor(() => expect(result.runtime.state).toBe("disposed"));
    expect(auth.getState().status).toBe("anonymous");
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
  });

  it("releases all resources when initialization fails", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const locks = new FakeLockManager();
    const environment = createEnvironment(auth, github, locks);
    github.mode = "failure";

    await expect(startModuleRuntime(
      {
        definition: definition("failure-cleanup-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      environment,
    )).rejects.toMatchObject({ status: 500 });
    expect(document.querySelector('[data-operation-gate-overlay="cloud"]')).toBeNull();

    github.mode = "ok";
    const retry = await startModuleRuntime(
      {
        definition: definition("failure-cleanup-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      environment,
    );
    expect(retry.status).toBe("ready");
    if (retry.status === "ready") await retry.runtime.dispose();
  });

  it("releases the lease when dependency construction fails before initialization", async () => {
    const auth = new FakeAuthService();
    const github = new EmptyGitHub();
    const locks = new FakeLockManager();
    const healthy = createEnvironment(auth, github, locks);
    const broken: ModuleRuntimeEnvironment = {
      ...healthy,
      fetch: 42 as unknown as ModuleRuntimeEnvironment["fetch"],
    };

    await expect(startModuleRuntime(
      {
        definition: definition("constructor-cleanup-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      broken,
    )).rejects.toThrow("injected fetch");

    const retry = await startModuleRuntime(
      {
        definition: definition("constructor-cleanup-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      healthy,
    );
    expect(retry.status).toBe("ready");
    if (retry.status === "ready") await retry.runtime.dispose();
  });

  it("continues critical cleanup when a registered disposer throws", async () => {
    const github = new EmptyGitHub();
    const locks = new FakeLockManager();
    const environment = createEnvironment(new ThrowingUnsubscribeAuthService(), github, locks);
    const first = await startModuleRuntime(
      {
        definition: definition("disposer-failure-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      environment,
    );
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;

    await expect(first.runtime.dispose()).rejects.toThrow("unsubscribe failed");
    expect(first.runtime.state).toBe("disposed");

    const retry = await startModuleRuntime(
      {
        definition: definition("disposer-failure-test"),
        appRoot: createRoot(),
        hooks: { settle: () => null, project: () => undefined },
      },
      { ...environment, authService: new FakeAuthService() },
    );
    expect(retry.status).toBe("ready");
    if (retry.status === "ready") await retry.runtime.dispose();
  });
});
