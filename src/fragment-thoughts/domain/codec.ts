import { validateFragmentThoughtsPayload } from "./model";
import type { FragmentThoughtsPayload } from "./types";

export const FRAGMENT_THOUGHTS_FILE_PATH = "thoughts.json";

export function encodeFragmentThoughtsPayload(
  payloadValue: FragmentThoughtsPayload,
): ReadonlyMap<string, string> {
  const payload = validateFragmentThoughtsPayload(payloadValue);
  return new Map([
    [FRAGMENT_THOUGHTS_FILE_PATH, `${JSON.stringify(payload, null, 2)}\n`],
  ]);
}

export function decodeFragmentThoughtsPayload(
  files: ReadonlyMap<string, string>,
): unknown {
  if (!files || typeof files.entries !== "function") {
    throw new TypeError("Fragment Thoughts files must be a ReadonlyMap.");
  }

  const entries = [...files.entries()];
  if (entries.length === 0) {
    throw new TypeError(`Missing managed Fragment Thoughts file: ${FRAGMENT_THOUGHTS_FILE_PATH}`);
  }
  if (
    entries.length !== 1
    || entries[0]?.[0] !== FRAGMENT_THOUGHTS_FILE_PATH
  ) {
    throw new TypeError(
      `Fragment Thoughts must contain only ${FRAGMENT_THOUGHTS_FILE_PATH}.`,
    );
  }

  const [filePath, text] = entries[0];
  if (typeof filePath !== "string" || typeof text !== "string") {
    throw new TypeError("Fragment Thoughts file paths and contents must be strings.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`Fragment Thoughts file is not valid JSON: ${filePath}`);
  }
  return value;
}
