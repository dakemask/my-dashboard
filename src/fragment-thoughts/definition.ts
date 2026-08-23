import { defineJsonModule } from "../shared";
import {
  applyFragmentThoughtsEvent,
  createEmptyFragmentThoughtsPayload,
  decodeFragmentThoughtsPayload,
  encodeFragmentThoughtsPayload,
  invertFragmentThoughtsEvent,
  migrateFragmentThoughtsV1ToV2,
  validateFragmentThoughtsPayload,
  type FragmentThoughtsEvent,
  type FragmentThoughtsPayload,
} from "./domain";

export const fragmentThoughtsDefinition = defineJsonModule<
  FragmentThoughtsPayload,
  FragmentThoughtsEvent
>({
  moduleId: "fragment-thoughts",
  createEmpty: createEmptyFragmentThoughtsPayload,
  migration: {
    currentVersion: 2,
    migrate: (value, fromVersion) => {
      if (fromVersion === 1) return migrateFragmentThoughtsV1ToV2(value);
      throw new TypeError(`Unsupported Fragment Thoughts schema version: ${fromVersion}`);
    },
  },
  validate: validateFragmentThoughtsPayload,
  history: {
    capacity: 100,
    apply: applyFragmentThoughtsEvent,
    invert: invertFragmentThoughtsEvent,
  },
  encode: encodeFragmentThoughtsPayload,
  decode: decodeFragmentThoughtsPayload,
});

/** Descriptive alias for module wiring code. */
export const fragmentThoughtsModuleDefinition = fragmentThoughtsDefinition;
