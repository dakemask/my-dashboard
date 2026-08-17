import { defineJsonModule } from "../shared";
import {
  applyMindMapEvent,
  createEmptyMindMapPayload,
  decodeMindMapPayload,
  encodeMindMapPayload,
  invertMindMapEvent,
  validateMindMapPayload,
  type MindMapEvent,
  type MindMapPayload,
} from "./domain";

export const mindMapDefinition = defineJsonModule<MindMapPayload, MindMapEvent>({
  moduleId: "mind-maps",
  createEmpty: createEmptyMindMapPayload,
  migration: {
    currentVersion: 1,
    migrate: () => {
      throw new TypeError("Mind Maps has no schema migration below version 1.");
    },
  },
  validate: validateMindMapPayload,
  history: {
    capacity: 100,
    apply: applyMindMapEvent,
    invert: invertMindMapEvent,
  },
  encode: encodeMindMapPayload,
  decode: decodeMindMapPayload,
});

/** Descriptive alias for module wiring code. */
export const mindMapModuleDefinition = mindMapDefinition;
