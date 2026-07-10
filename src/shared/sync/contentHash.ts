import { jsonSnapshotKey } from "../history";

export async function hashJsonPayload(payload: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to hash module data.");
  }

  const canonical = jsonSnapshotKey(payload);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
