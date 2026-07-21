// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteRevisionSnapshot } from "../../src/shared/github";
import { createRevisionPoller } from "../../src/shared/sync/revisionPoller";

function snapshot(
  revision: string,
  updatedAt = "2026-07-10T00:00:00.000Z",
): RemoteRevisionSnapshot {
  return {
    revision,
    updatedAt,
    managedFiles: ["data.json"],
    commitSha: revision,
  };
}

afterEach(() => vi.useRealTimers());

describe("RevisionPoller", () => {
  it("polls immediately and schedules the next foreground check", async () => {
    vi.useFakeTimers();
    const remote = snapshot("remote-1");
    const readRevision = vi.fn(async () => remote);
    const onRevision = vi.fn();
    const poller = createRevisionPoller({ readRevision, onRevision, random: () => 0 });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRevision).toHaveBeenCalledWith(remote);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readRevision).toHaveBeenCalledTimes(2);
    await poller.stop();
  });

  it("silently retries ordinary failures on the next cycle", async () => {
    vi.useFakeTimers();
    const readRevision = vi
      .fn<() => Promise<RemoteRevisionSnapshot | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot("remote-2", "2026-07-10T01:00:00.000Z"));
    const onRevision = vi.fn();
    const poller = createRevisionPoller({ readRevision, onRevision, random: () => 0 });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRevision).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRevision).toHaveBeenCalledWith(
      snapshot("remote-2", "2026-07-10T01:00:00.000Z"),
    );
    await poller.stop();
  });

  it("reports authentication failures through the dedicated callback", async () => {
    vi.useFakeTimers();
    const authError = { status: 401 };
    const onAuthenticationError = vi.fn();
    const poller = createRevisionPoller({
      readRevision: vi.fn(async () => Promise.reject(authError)),
      onRevision: vi.fn(),
      isAuthenticationError: (error) => (error as { status?: number }).status === 401,
      onAuthenticationError,
      random: () => 0,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthenticationError).toHaveBeenCalledWith(authError);
    await poller.stop();
  });

  it("reschedules in both directions when page visibility changes", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const pageDocument = document;
    vi.spyOn(pageDocument, "hidden", "get").mockImplementation(() => hidden);
    const readRevision = vi.fn(async () => snapshot("remote-1"));
    const poller = createRevisionPoller({
      readRevision,
      onRevision: vi.fn(),
      document: pageDocument,
      random: () => 0,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readRevision).toHaveBeenCalledTimes(1);

    hidden = true;
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readRevision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(readRevision).toHaveBeenCalledTimes(2);

    hidden = false;
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readRevision).toHaveBeenCalledTimes(3);
    await poller.stop();
  });

  it("waits for an in-flight read and suppresses callbacks after stop", async () => {
    vi.useFakeTimers();
    let resolveRead!: (revision: RemoteRevisionSnapshot | null) => void;
    const readRevision = vi.fn(() => new Promise<RemoteRevisionSnapshot | null>((resolve) => {
      resolveRead = resolve;
    }));
    const onRevision = vi.fn();
    const poller = createRevisionPoller({ readRevision, onRevision, random: () => 0 });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = poller.stop();
    resolveRead(snapshot("late-revision"));
    await stopped;

    expect(onRevision).not.toHaveBeenCalled();
  });
});
