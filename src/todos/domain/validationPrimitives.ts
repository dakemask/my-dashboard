const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function requireExactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or extra fields.`);
  }
  return record;
}

export function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const id = value.toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new TypeError(`${label} must be a UUID.`);
  return id;
}

export function requireIndex(value: unknown, label: string, present: boolean): number {
  if (!Number.isInteger(value) || (present ? (value as number) < 0 : value !== -1)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value as number;
}
