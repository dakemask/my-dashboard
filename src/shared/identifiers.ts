export const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

export function isModuleId(value: unknown): value is string {
  return typeof value === "string" && MODULE_ID_PATTERN.test(value);
}

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}
