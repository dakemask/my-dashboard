import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccountSetupError,
  bindFirstAccount,
  clearAccountProfile,
  inspectFirstAccount,
} from "../../src/home/accountSetup";
import { fragmentThoughtsDefinition } from "../../src/fragment-thoughts/definition";
import { mindMapDefinition } from "../../src/mind-map/definition";
import {
  createModuleLocalEnvelope,
  ModuleLocalStore,
} from "../../src/shared/persistence";
import { hashContentKey } from "../../src/shared/sync";

const session = {
  credentials: { username: "octocat", token: "secret-token" },
  repository: {
    owner: "octocat",
    repository: "my-dashboard-data",
    branch: "main",
  },
};

function createEmptyRepositoryFetch() {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/my-dashboard-data")[1] ?? "";
    const method = init.method ?? "GET";
    if (method === "GET" && endpoint === "/git/ref/heads/main") {
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

async function createVersionedRepositoryFetch() {
  const blobs = new Map<string, string>();
  const entries: Array<{ path: string; mode: string; type: "blob"; sha: string }> = [];
  for (const definition of [mindMapDefinition, fragmentThoughtsDefinition]) {
    const payload = definition.moduleId === "fragment-thoughts"
      ? fragmentThoughtsDefinition.validate({
          thoughts: [{
            id: "00000000-0000-4000-8000-000000000101",
            versions: [{
              id: "00000000-0000-4000-8000-000000000102",
              content: "cloud thought",
              createdAt: "2026-07-27T12:00:00.000Z",
            }],
            collapsedVersionIds: [],
          }],
        })
      : definition.createEmpty();
    const encoded = await definition.encode(payload);
    const managedFiles = [...encoded.keys()].sort();
    for (const [path, text] of encoded) {
      const sha = `${definition.moduleId}-${path}`;
      blobs.set(sha, text);
      entries.push({
        path: `data/${definition.moduleId}/${path}`,
        mode: "100644",
        type: "blob",
        sha,
      });
    }
    const revisionSha = `${definition.moduleId}-revision`;
    blobs.set(revisionSha, `${JSON.stringify({
      revision: `${definition.moduleId}-r1`,
      updatedAt: "2026-07-27T12:00:00.000Z",
      schemaVersion: 1,
      managedFiles,
    })}\n`);
    entries.push({
      path: `data/${definition.moduleId}/revision.json`,
      mode: "100644",
      type: "blob",
      sha: revisionSha,
    });
  }

  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/my-dashboard-data")[1] ?? "";
    const method = init.method ?? "GET";
    if (method === "GET" && endpoint === "/git/ref/heads/main") {
      return Response.json({ object: { sha: "commit-versioned" } });
    }
    if (method === "GET" && endpoint === "/git/commits/commit-versioned") {
      return Response.json({ sha: "commit-versioned", tree: { sha: "tree-versioned" } });
    }
    if (method === "GET" && endpoint === "/git/trees/tree-versioned") {
      return Response.json({
        sha: "tree-versioned",
        truncated: false,
        tree: entries,
      });
    }
    const blobSha = endpoint.startsWith("/git/blobs/")
      ? decodeURIComponent(endpoint.slice("/git/blobs/".length))
      : null;
    if (method === "GET" && blobSha && blobs.has(blobSha)) {
      return Response.json({
        encoding: "base64",
        content: Buffer.from(blobs.get(blobSha)!, "utf8").toString("base64"),
      });
    }
    return new Response(null, { status: 404 });
  });
}

function createWritableRepositoryFetch(options: { failPatchNumber?: number } = {}) {
  let headCommit = "commit-1";
  let sequence = 1;
  let patchCount = 0;
  const commits = new Map([["commit-1", "tree-1"]]);
  const trees = new Map<string, Array<{
    path: string;
    mode: string;
    type: "blob";
    sha: string;
  }>>([["tree-1", []]]);

  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/my-dashboard-data")[1] ?? "";
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method === "GET" && endpoint === "/git/ref/heads/main") {
      return Response.json({ object: { sha: headCommit } });
    }
    if (method === "GET" && endpoint.startsWith("/git/commits/")) {
      const sha = decodeURIComponent(endpoint.slice("/git/commits/".length));
      return Response.json({ sha, tree: { sha: commits.get(sha) } });
    }
    if (method === "GET" && endpoint.startsWith("/git/trees/")) {
      const sha = decodeURIComponent(endpoint.slice("/git/trees/".length));
      return Response.json({
        sha,
        truncated: false,
        tree: trees.get(sha) ?? [],
      });
    }
    if (method === "POST" && endpoint === "/git/blobs") {
      return Response.json({ sha: `blob-${sequence++}` });
    }
    if (method === "POST" && endpoint === "/git/trees") {
      const baseTree = String(body.base_tree);
      const nextEntries = new Map(
        (trees.get(baseTree) ?? []).map((entry) => [entry.path, entry]),
      );
      for (const entry of body.tree as Array<{
        path: string;
        mode: string;
        type: "blob";
        sha: string | null;
      }>) {
        if (entry.sha === null) nextEntries.delete(entry.path);
        else nextEntries.set(entry.path, { ...entry, sha: entry.sha });
      }
      const sha = `tree-${sequence++}`;
      trees.set(sha, [...nextEntries.values()]);
      return Response.json({ sha });
    }
    if (method === "POST" && endpoint === "/git/commits") {
      const sha = `commit-${sequence++}`;
      commits.set(sha, String(body.tree));
      return Response.json({ sha });
    }
    if (method === "PATCH" && endpoint === "/git/refs/heads/main") {
      patchCount += 1;
      if (patchCount === options.failPatchNumber) {
        return Response.json({ message: "injected failure" }, { status: 500 });
      }
      headCommit = String(body.sha);
      return Response.json({ object: { sha: headCommit } });
    }
    return new Response(null, { status: 404 });
  });
}

describe("first account setup", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });
  });

  it("binds a fresh local dashboard to an empty cloud account", async () => {
    const request = createEmptyRepositoryFetch();

    await expect(inspectFirstAccount(session, request)).resolves.toEqual({
      localHasData: false,
      cloudHasData: false,
      needsChoice: false,
      suggestedDirection: "cloud-wins",
    });
    await expect(
      bindFirstAccount(session, "github-octocat", "cloud-wins", request),
    ).resolves.toBeUndefined();

    const mindMaps = new ModuleLocalStore("mind-maps", {
      profileId: "github-octocat",
    });
    const fragmentThoughts = new ModuleLocalStore("fragment-thoughts", {
      profileId: "github-octocat",
    });
    expect(await mindMaps.load()).not.toBeNull();
    expect(await fragmentThoughts.load()).not.toBeNull();
    mindMaps.close();
    fragmentThoughts.close();
  });

  it("binds a fresh local dashboard to existing versioned cloud modules", async () => {
    const request = await createVersionedRepositoryFetch();

    await expect(inspectFirstAccount(session, request)).resolves.toMatchObject({
      localHasData: false,
      cloudHasData: true,
      needsChoice: false,
      suggestedDirection: "cloud-wins",
    });
    await expect(
      bindFirstAccount(session, "github-octocat", "cloud-wins", request),
    ).resolves.toBeUndefined();
  });

  it("uploads existing local data when the first account cloud is empty", async () => {
    const payload = fragmentThoughtsDefinition.validate({
      thoughts: [{
        id: "00000000-0000-4000-8000-000000000201",
        versions: [{
          id: "00000000-0000-4000-8000-000000000202",
          content: "local thought",
          createdAt: "2026-07-27T13:00:00.000Z",
        }],
        collapsedVersionIds: [],
      }],
    });
    const hash = await hashContentKey(fragmentThoughtsDefinition.contentKey(payload));
    const local = new ModuleLocalStore("fragment-thoughts", { profileId: "local" });
    await local.initialize({
      ...createModuleLocalEnvelope(
        payload,
        hash,
        "00000000-0000-4000-8000-000000000203",
        1,
      ),
      localSavedAt: "2026-07-27T13:00:00.000Z",
    });
    local.close();
    const request = createWritableRepositoryFetch();

    await expect(inspectFirstAccount(session, request)).resolves.toMatchObject({
      localHasData: true,
      cloudHasData: false,
      needsChoice: false,
      suggestedDirection: "local-wins",
    });
    await expect(
      bindFirstAccount(session, "github-octocat", "local-wins", request),
    ).resolves.toBeUndefined();
  });

  it("preflights every module and rejects a damaged current-schema hash before cloud writes", async () => {
    const payload = fragmentThoughtsDefinition.validate({
      thoughts: [{
        id: "00000000-0000-4000-8000-000000000301",
        versions: [{
          id: "00000000-0000-4000-8000-000000000302",
          content: "must stay local",
          createdAt: "2026-07-27T14:00:00.000Z",
        }],
        collapsedVersionIds: [],
      }],
    });
    const local = new ModuleLocalStore("fragment-thoughts", { profileId: "local" });
    await local.initialize({
      ...createModuleLocalEnvelope(
        payload,
        "damaged-content-hash",
        "00000000-0000-4000-8000-000000000303",
        1,
      ),
      localSavedAt: "2026-07-27T14:00:00.000Z",
    });
    local.close();
    const request = createWritableRepositoryFetch();

    const failure = await bindFirstAccount(
      session,
      "github-octocat",
      "local-wins",
      request,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccountSetupError);
    expect(failure).toMatchObject({
      stage: "inspect",
      moduleId: "fragment-thoughts",
      remoteMayBePartiallyUpdated: false,
    });
    expect(String((failure as Error).message)).toContain("本机缓存未通过完整性校验");
    expect(request.mock.calls.filter(([input, init]) =>
      (init?.method ?? "GET") === "GET"
      && String(input).includes("/git/ref/heads/main")
    )).toHaveLength(3);
    expect(request.mock.calls.some(([, init]) =>
      ["POST", "PATCH"].includes(init?.method ?? "GET")
    )).toBe(false);

    const retainedLocal = new ModuleLocalStore("fragment-thoughts", {
      profileId: "local",
    });
    expect((await retainedLocal.load())?.contentHash).toBe("damaged-content-hash");
    retainedLocal.close();
  });

  it("never accepts the local source profile as a temporary account target", async () => {
    const payload = fragmentThoughtsDefinition.createEmpty();
    const hash = await hashContentKey(fragmentThoughtsDefinition.contentKey(payload));
    const local = new ModuleLocalStore("fragment-thoughts", { profileId: "local" });
    await local.initialize(createModuleLocalEnvelope(
      payload,
      hash,
      "00000000-0000-4000-8000-000000000351",
      1,
    ));
    local.close();
    const request = createWritableRepositoryFetch();

    await expect(
      bindFirstAccount(session, "local", "cloud-wins", request),
    ).rejects.toThrow("local source profile");
    await expect(clearAccountProfile("local")).rejects.toThrow("local source profile");
    expect(request).not.toHaveBeenCalled();

    const retainedLocal = new ModuleLocalStore("fragment-thoughts", {
      profileId: "local",
    });
    expect(await retainedLocal.load()).not.toBeNull();
    retainedLocal.close();
  });

  it("cleans every temporary account database after a midway local-wins failure", async () => {
    const payload = fragmentThoughtsDefinition.validate({
      thoughts: [{
        id: "00000000-0000-4000-8000-000000000401",
        versions: [{
          id: "00000000-0000-4000-8000-000000000402",
          content: "keep the local source",
          createdAt: "2026-07-27T15:00:00.000Z",
        }],
        collapsedVersionIds: [],
      }],
    });
    const hash = await hashContentKey(fragmentThoughtsDefinition.contentKey(payload));
    const local = new ModuleLocalStore("fragment-thoughts", { profileId: "local" });
    await local.initialize({
      ...createModuleLocalEnvelope(
        payload,
        hash,
        "00000000-0000-4000-8000-000000000403",
        1,
      ),
      localSavedAt: "2026-07-27T15:00:00.000Z",
    });
    local.close();
    const request = createWritableRepositoryFetch({ failPatchNumber: 2 });

    const failure = await bindFirstAccount(
      session,
      "github-octocat",
      "local-wins",
      request,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AccountSetupError);
    expect(failure).toMatchObject({
      stage: "local-wins",
      moduleId: "mind-maps",
      remoteMayBePartiallyUpdated: true,
    });
    expect(String((failure as Error).message)).toContain("不会自动回滚");
    expect(String((failure as Error).message)).toContain("本地覆盖云端");
    expect(request.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(2);

    for (const moduleId of ["todos", "mind-maps", "fragment-thoughts"]) {
      const temporary = new ModuleLocalStore(moduleId, {
        profileId: "github-octocat",
      });
      expect(await temporary.load()).toBeNull();
      temporary.close();
    }
    const retainedLocal = new ModuleLocalStore("fragment-thoughts", {
      profileId: "local",
    });
    expect((await retainedLocal.load())?.payload).toEqual(payload);
    retainedLocal.close();
  });
});
