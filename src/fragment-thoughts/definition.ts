import { defineJsonModule } from "../shared";
import {
  applyFragmentThoughtsEvent,
  createEmptyFragmentThoughtsPayload,
  decodeFragmentThoughtsPayload,
  encodeFragmentThoughtsPayload,
  invertFragmentThoughtsEvent,
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
    currentVersion: 1,
    migrate: () => {
      throw new TypeError("Fragment Thoughts has no schema migration below version 1.");
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
