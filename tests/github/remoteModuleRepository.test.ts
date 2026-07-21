import { describe, expect, it, vi } from "vitest";
import {
  GitHubGitDataClient,
  RemoteModuleConflictError,
  RemoteModulePathError,
  RemoteModuleRepository,
  type GitHubFetch,
  type RemoteModuleCodec,
  type RemoteModuleRevision,
} from "../../src/shared/github";

interface TestData {
  files: ReadonlyMap<string, string>;
}

const codec: RemoteModuleCodec<TestData> = {
  moduleId: "test-module",
  validate(value: unknown): TestData {
    const files = (value as Partial<TestData>)?.files;
    if (!(files instanceof Map)) {
      throw new TypeError("invalid test module data");
    }
    return { files: new Map(files) };
  },
  encode: (data) => data.files,
  decode: (files) => ({ files: new Map(files) }),
};

describe("RemoteModuleRepository", () => {
  it("rejects module identifiers that begin with a number", () => {
    const github = new FakeGitHub();
    const client = new GitHubGitDataClient({
      owner: "alice",
      token: "secret-token",
      fetch: github.fetch,
      onCredentialsInvalid: () => undefined,
    });
    expect(() => new RemoteModuleRepository(client, { ...codec, moduleId: "1-test" })).toThrow(
      RemoteModulePathError,
    );
  });

  it("notifies the auth boundary only for an explicit HTTP 401", async () => {
    const onCredentialsInvalid = vi.fn();
    const unauthorized = new GitHubGitDataClient({
      owner: "alice",
      token: "expired-token",
      fetch: async () => new Response(null, { status: 401 }),
      onCredentialsInvalid,
    });

    await expect(unauthorized.getBranchSnapshot()).rejects.toMatchObject({ status: 401 });
    expect(onCredentialsInvalid).toHaveBeenCalledOnce();

    const rateLimited = new GitHubGitDataClient({
      owner: "alice",
      token: "valid-token",
      fetch: async () => new Response(null, { status: 403 }),
      onCredentialsInvalid,
    });
    await expect(rateLimited.getBranchSnapshot()).rejects.toMatchObject({ status: 403 });
    expect(onCredentialsInvalid).toHaveBeenCalledOnce();
  });

  it("pulls the manifest and every managed blob from one commit snapshot", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", ["a.json", "nested/b.json"]), {
      "a.json": "A from r1",
      "nested/b.json": "B from r1",
    });
    const originalHead = github.head;
    const repository = createRepository(github);

    const pulled = await repository.pull();

    expect(pulled).toMatchObject({ revision: "r1", commitSha: originalHead });
    expect([...pulled!.data.files]).toEqual([
      ["a.json", "A from r1"],
      ["nested/b.json", "B from r1"],
    ]);
    expect(github.requestedCommitShas).toEqual([originalHead]);
    expect(github.requestedTreeShas).toEqual([github.commits.get(originalHead)!.tree]);
  });

  it("validates a decoded payload before returning it", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", ["data.txt"]), { "data.txt": "invalid" });
    const client = new GitHubGitDataClient({
      owner: "alice",
      token: "secret-token",
      fetch: github.fetch,
      onCredentialsInvalid: () => undefined,
    });
    const repository = new RemoteModuleRepository(client, {
      ...codec,
      validate: () => {
        throw new TypeError("decoded payload rejected");
      },
    });

    await expect(repository.pull()).rejects.toThrow("decoded payload rejected");
  });

  it("uses one commit, preserves unknown files, and deletes only removed managed files", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", ["keep.json", "remove.json"]), {
      "keep.json": "old",
      "remove.json": "remove me",
    }, {
      "notes.txt": "unknown",
      "unknown/nested.txt": "also unknown",
    });
    const repository = createRepository(github);
    const commitsBefore = github.createdCommitCount;

    const result = await repository.push(
      { files: new Map([["keep.json", "new"], ["new.json", "created"]]) },
      { expectedRevision: "r1", nextRevision: "r2", updatedAt: "2026-07-10T10:00:00.000Z" },
    );

    expect(result).toMatchObject({ status: "committed", revision: "r2" });
    expect(github.createdCommitCount - commitsBefore).toBe(1);
    expect(github.readHeadFile("data/test-module/keep.json")).toBe("new");
    expect(github.readHeadFile("data/test-module/new.json")).toBe("created");
    expect(github.readHeadFile("data/test-module/remove.json")).toBeNull();
    expect(github.readHeadFile("data/test-module/notes.txt")).toBe("unknown");
    expect(github.readHeadFile("data/test-module/unknown/nested.txt")).toBe("also unknown");
    expect(JSON.parse(github.readHeadFile("data/test-module/revision.json")!)).toEqual({
      revision: "r2",
      updatedAt: "2026-07-10T10:00:00.000Z",
      managedFiles: ["keep.json", "new.json"],
    });
    expect(github.lastPatchBody).toEqual({ sha: result.commitSha, force: false });
  });

  it("performs expected-revision CAS before creating blobs", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("cloud-r2", ["data.json"]), { "data.json": "cloud" });
    const repository = createRepository(github);
    const writesBefore = github.writeCount;

    await expect(repository.push(
      { files: new Map([["data.json", "local"]]) },
      { expectedRevision: "stale-r1", nextRevision: "local-r2" },
    )).rejects.toEqual(expect.objectContaining<Partial<RemoteModuleConflictError>>({
      expectedRevision: "stale-r1",
      actualRevision: "cloud-r2",
      actualUpdatedAt: "2026-07-10T09:00:00.000Z",
    }));
    expect(github.writeCount).toBe(writesBefore);
  });

  it("idempotently confirms a previously committed next revision", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("next-r2", ["data.json"]), { "data.json": "saved" });
    const repository = createRepository(github);
    const writesBefore = github.writeCount;

    const result = await repository.push(
      { files: new Map([["data.json", "retry payload"]]) },
      { expectedRevision: "old-r1", nextRevision: "next-r2" },
    );

    expect(result.status).toBe("already-committed");
    expect(github.writeCount).toBe(writesBefore);
  });

  it("retries a cross-module ref race against the new branch head", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", ["data.json"]), { "data.json": "old" });
    github.patchBehavior = "cross-module-race-once";
    const repository = createRepository(github);

    const result = await repository.push(
      { files: new Map([["data.json", "new"]]) },
      { expectedRevision: "r1", nextRevision: "r2" },
    );

    expect(result.status).toBe("committed");
    expect(github.patchCount).toBe(2);
    expect(github.readHeadFile("data/other-module/external.json")).toBe("external");
    expect(github.readHeadFile("data/test-module/data.json")).toBe("new");
  });

  it("turns a same-module ref race into a conflict", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", ["data.json"]), { "data.json": "old" });
    github.patchBehavior = "same-module-race-once";
    const repository = createRepository(github);

    await expect(repository.push(
      { files: new Map([["data.json", "local"]]) },
      { expectedRevision: "r1", nextRevision: "local-r2" },
    )).rejects.toEqual(expect.objectContaining({
      expectedRevision: "r1",
      actualRevision: "remote-r2",
    }));
    expect(github.patchCount).toBe(1);
  });

  it("confirms nextRevision when the ref update succeeded but its response was lost", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", ["data.json"]), { "data.json": "old" });
    github.patchBehavior = "apply-then-throw-once";
    const repository = createRepository(github);

    const result = await repository.push(
      { files: new Map([["data.json", "new"]]) },
      { expectedRevision: "r1", nextRevision: "r2" },
    );

    expect(result.status).toBe("already-committed");
    expect(result.revision).toBe("r2");
    expect(github.patchCount).toBe(1);
  });

  it("rejects encoder and unknown-file collisions before writing", async () => {
    const github = new FakeGitHub();
    github.seedModule("test-module", revision("r1", []), {}, { "unknown/note.txt": "keep" });
    const repository = createRepository(github);

    await expect(repository.push(
      { files: new Map([["unknown", "would replace a directory"]]) },
      { expectedRevision: "r1", nextRevision: "r2" },
    )).rejects.toBeInstanceOf(RemoteModulePathError);

    await expect(repository.push(
      { files: new Map([["folder", "one"], ["folder/item.json", "two"]]) },
      { expectedRevision: "r1", nextRevision: "r3" },
    )).rejects.toBeInstanceOf(RemoteModulePathError);
    expect(github.writeCount).toBe(0);
  });
});

function createRepository(github: FakeGitHub): RemoteModuleRepository<TestData> {
  const client = new GitHubGitDataClient({
    owner: "alice",
    token: "secret-token",
    fetch: github.fetch,
    onCredentialsInvalid: () => undefined,
  });
  return new RemoteModuleRepository(client, codec, { now: () => new Date("2026-07-10T10:00:00.000Z") });
}

function revision(revisionId: string, managedFiles: string[]): RemoteModuleRevision {
  return {
    revision: revisionId,
    updatedAt: "2026-07-10T09:00:00.000Z",
    managedFiles,
  };
}

type PatchBehavior = "normal" | "cross-module-race-once" | "same-module-race-once" | "apply-then-throw-once";

class FakeGitHub {
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, { tree: string; parent: string | null }>();
  readonly requestedCommitShas: string[] = [];
  readonly requestedTreeShas: string[] = [];
  head: string;
  patchBehavior: PatchBehavior = "normal";
  patchCount = 0;
  writeCount = 0;
  createdCommitCount = 0;
  lastPatchBody: unknown = null;
  #nextId = 1;

  constructor() {
    const tree = this.#storeTree(new Map());
    this.head = this.#storeCommit(tree, null, false);
  }

  readonly fetch: GitHubFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const marker = "/repos/alice/my-dashboard-data";
    const endpoint = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};

    if (method !== "GET") {
      this.writeCount += 1;
    }

    if (method === "GET" && endpoint === "/git/ref/heads/main") {
      return jsonResponse({ object: { sha: this.head } });
    }

    if (method === "GET" && endpoint.startsWith("/git/commits/")) {
      const sha = decodeURIComponent(endpoint.slice("/git/commits/".length));
      const commit = this.commits.get(sha);
      if (!commit) return jsonResponse({}, 404);
      this.requestedCommitShas.push(sha);
      return jsonResponse({ sha, tree: { sha: commit.tree } });
    }

    if (method === "GET" && endpoint.startsWith("/git/trees/")) {
      const sha = decodeURIComponent(endpoint.slice("/git/trees/".length));
      const tree = this.trees.get(sha);
      if (!tree) return jsonResponse({}, 404);
      this.requestedTreeShas.push(sha);
      return jsonResponse({
        sha,
        truncated: false,
        tree: [...tree].map(([path, blobSha]) => ({ path, mode: "100644", type: "blob", sha: blobSha })),
      });
    }

    if (method === "GET" && endpoint.startsWith("/git/blobs/")) {
      const sha = decodeURIComponent(endpoint.slice("/git/blobs/".length));
      const text = this.blobs.get(sha);
      return text === undefined
        ? jsonResponse({}, 404)
        : jsonResponse({ encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") });
    }

    if (method === "POST" && endpoint === "/git/blobs") {
      const sha = this.#storeBlob(String(body.content));
      return jsonResponse({ sha }, 201);
    }

    if (method === "POST" && endpoint === "/git/trees") {
      const base = this.trees.get(String(body.base_tree));
      if (!base) return jsonResponse({}, 422);
      const tree = new Map(base);
      for (const entry of body.tree as Array<{ path: string; sha: string | null }>) {
        if (entry.sha === null) tree.delete(entry.path);
        else tree.set(entry.path, entry.sha);
      }
      return jsonResponse({ sha: this.#storeTree(tree) }, 201);
    }

    if (method === "POST" && endpoint === "/git/commits") {
      const parent = (body.parents as string[])[0] ?? null;
      const sha = this.#storeCommit(String(body.tree), parent, true);
      return jsonResponse({ sha }, 201);
    }

    if (method === "PATCH" && endpoint === "/git/refs/heads/main") {
      this.patchCount += 1;
      this.lastPatchBody = body;

      if (this.patchBehavior === "cross-module-race-once") {
        this.patchBehavior = "normal";
        this.#externalCommit("data/other-module/external.json", "external");
        return jsonResponse({}, 422);
      }

      if (this.patchBehavior === "same-module-race-once") {
        this.patchBehavior = "normal";
        const next = revision("remote-r2", ["data.json"]);
        this.#externalCommit("data/test-module/data.json", "remote");
        this.#externalCommit("data/test-module/revision.json", `${JSON.stringify(next)}\n`);
        return jsonResponse({}, 422);
      }

      const nextHead = String(body.sha);
      const commit = this.commits.get(nextHead);
      if (!commit || commit.parent !== this.head) return jsonResponse({}, 422);
      this.head = nextHead;

      if (this.patchBehavior === "apply-then-throw-once") {
        this.patchBehavior = "normal";
        throw new TypeError("simulated lost response");
      }

      return jsonResponse({ object: { sha: this.head } });
    }

    return jsonResponse({}, 404);
  };

  seedModule(
    moduleId: string,
    manifest: RemoteModuleRevision,
    files: Record<string, string>,
    unknownFiles: Record<string, string> = {},
  ): void {
    const tree = new Map(this.trees.get(this.commits.get(this.head)!.tree)!);
    for (const [path, text] of Object.entries({ ...files, ...unknownFiles })) {
      tree.set(`data/${moduleId}/${path}`, this.#storeBlob(text));
    }
    tree.set(`data/${moduleId}/revision.json`, this.#storeBlob(`${JSON.stringify(manifest)}\n`));
    const treeSha = this.#storeTree(tree);
    this.head = this.#storeCommit(treeSha, this.head, false);
  }

  readHeadFile(path: string): string | null {
    const tree = this.trees.get(this.commits.get(this.head)!.tree)!;
    const blobSha = tree.get(path);
    return blobSha ? this.blobs.get(blobSha) ?? null : null;
  }

  #externalCommit(path: string, text: string): void {
    const tree = new Map(this.trees.get(this.commits.get(this.head)!.tree)!);
    tree.set(path, this.#storeBlob(text));
    const treeSha = this.#storeTree(tree);
    this.head = this.#storeCommit(treeSha, this.head, false);
  }

  #storeBlob(text: string): string {
    const sha = `blob-${this.#nextId++}`;
    this.blobs.set(sha, text);
    return sha;
  }

  #storeTree(tree: Map<string, string>): string {
    const sha = `tree-${this.#nextId++}`;
    this.trees.set(sha, new Map(tree));
    return sha;
  }

  #storeCommit(tree: string, parent: string | null, count: boolean): string {
    const sha = `commit-${this.#nextId++}`;
    this.commits.set(sha, { tree, parent });
    if (count) this.createdCommitCount += 1;
    return sha;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
