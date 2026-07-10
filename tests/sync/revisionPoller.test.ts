// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRevisionPoller } from "../../src/shared/sync/revisionPoller";

afterEach(() => vi.useRealTimers());

describe("RevisionPoller", () => {
  it("polls immediately and schedules the next foreground check", async () => {
    vi.useFakeTimers();
    const readRevision = vi.fn(async () => "remote-1");
    const onRevision = vi.fn();
    const poller = createRevisionPoller({ readRevision, onRevision, random: () => 0 });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRevision).toHaveBeenCalledWith("remote-1");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readRevision).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("silently retries ordinary failures on the next cycle", async () => {
    vi.useFakeTimers();
    const readRevision = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("remote-2");
    const onRevision = vi.fn();
    const poller = createRevisionPoller({ readRevision, onRevision, random: () => 0 });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRevision).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRevision).toHaveBeenCalledWith("remote-2");
    poller.stop();
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
    poller.stop();
  });

  it("reschedules in both directions when page visibility changes", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const pageDocument = document;
    vi.spyOn(pageDocument, "hidden", "get").mockImplementation(() => hidden);
    const readRevision = vi.fn(async () => "remote-1");
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
    poller.stop();
  });
});
