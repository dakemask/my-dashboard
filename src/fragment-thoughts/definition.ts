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
