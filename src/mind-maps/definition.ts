import { defineJsonModule } from "../shared";
import {
  applyMindMapEvent,
  createEmptyMindMapPayload,
  decodeMindMapPayload,
  encodeMindMapPayload,
  invertMindMapEvent,
  migrateMindMapV1ToV2,
  migrateMindMapV2ToV3,
  validateMindMapPayload,
  type MindMapEvent,
  type MindMapPayload,
} from "./domain";

export const mindMapDefinition = defineJsonModule<MindMapPayload, MindMapEvent>({
  moduleId: "mind-maps",
  createEmpty: createEmptyMindMapPayload,
  migration: {
    currentVersion: 3,
    migrate: (value, fromVersion) => {
      if (fromVersion === 1) return migrateMindMapV1ToV2(value);
      if (fromVersion === 2) return migrateMindMapV2ToV3(value);
      throw new TypeError(`Unsupported Mind Maps schema version: ${fromVersion}`);
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
