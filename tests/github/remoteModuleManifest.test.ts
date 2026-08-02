import { describe, expect, it } from "vitest";

import {
  parseRemoteModuleManifest,
  serializeRemoteModuleManifest,
} from "../../src/shared/github/remoteModuleManifest";
import {
  getModuleRoot,
  remoteModulePathsCollide,
  validateManifestPaths,
} from "../../src/shared/github/remoteModulePaths";
import {
  RemoteModuleFormatError,
  RemoteModulePathError,
} from "../../src/shared/github/types";

describe("remote module manifest and paths", () => {
  it("parses and serializes the stable revision.json shape", () => {
    const manifest = parseRemoteModuleManifest(`${JSON.stringify({
      revision: "r2",
      updatedAt: "2026-08-03T02:00:00.000Z",
      schemaVersion: 2,
      managedFiles: ["a.json", "nested/b.md"],
    })}\n`);

    expect(manifest).toEqual({
      revision: "r2",
      updatedAt: "2026-08-03T02:00:00.000Z",
      schemaVersion: 2,
      managedFiles: ["a.json", "nested/b.md"],
    });
    expect(JSON.parse(serializeRemoteModuleManifest(manifest))).toEqual({
      revision: "r2",
      updatedAt: "2026-08-03T02:00:00.000Z",
      schemaVersion: 2,
      managedFiles: ["a.json", "nested/b.md"],
    });
  });

  it("keeps unversioned manifests compatible by omitting a null schemaVersion", () => {
    const text = serializeRemoteModuleManifest({
      revision: "legacy",
      updatedAt: "2026-08-03T02:00:00.000Z",
      schemaVersion: null,
      managedFiles: [],
    });

    expect(JSON.parse(text)).not.toHaveProperty("schemaVersion");
    expect(parseRemoteModuleManifest(text).schemaVersion).toBeNull();
  });

  it("rejects unsorted, case-colliding, and parent-child managed paths", () => {
    expect(() => validateManifestPaths(["z.json", "a.json"])).toThrow(
      RemoteModuleFormatError,
    );
    expect(() => validateManifestPaths(["A.json", "a.json"])).toThrow(
      RemoteModuleFormatError,
    );
    expect(() => validateManifestPaths(["folder", "folder/item.json"])).toThrow(
      RemoteModuleFormatError,
    );
    expect(() => validateManifestPaths(["a", "a-foo", "a/z"])).toThrow(
      RemoteModuleFormatError,
    );
  });

  it("centralizes module roots and case-insensitive path collision checks", () => {
    expect(getModuleRoot("fragment-thoughts")).toBe("data/fragment-thoughts");
    expect(() => getModuleRoot("FragmentThoughts")).toThrow(RemoteModulePathError);
    expect(remoteModulePathsCollide("data/mod/Folder", "data/mod/folder/a.json")).toBe(true);
    expect(remoteModulePathsCollide("data/mod/a.json", "data/mod/b.json")).toBe(false);
  });
});
