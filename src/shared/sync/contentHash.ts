export async function hashContentKey(contentKey: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to hash module data.");
  }
  if (typeof contentKey !== "string") {
    throw new TypeError("A payload content key must be a string.");
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(contentKey));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
