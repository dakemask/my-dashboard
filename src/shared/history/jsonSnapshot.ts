type JsonPrimitive = null | boolean | number | string;

function snapshotValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("History payload numbers must be finite.");
    }
    return value;
  }

  if (typeof value !== "object") {
    throw new TypeError("History payloads must be JSON-compatible.");
  }

  if (ancestors.has(value)) {
    throw new TypeError("History payloads cannot contain circular references.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("History payload arrays cannot be sparse.");
        }
        clone.push(snapshotValue(value[index], ancestors));
      }
      return Object.freeze(clone);
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("History payload objects must be plain JSON objects.");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new TypeError("History payload objects cannot have symbol keys.");
    }

    const clone: Record<string, unknown> = {};
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          "History payload properties must be enumerable data properties.",
        );
      }
      clone[key] = snapshotValue(descriptor.value, ancestors);
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

export function createJsonSnapshot<T>(value: T): T {
  return snapshotValue(value, new Set()) as T;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value as JsonPrimitive);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function jsonSnapshotKey(value: unknown): string {
  return canonicalValue(value);
}
