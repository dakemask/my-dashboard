/** Compatibility facade for the module runtime public and test-injection API. */
export {
  ModuleRuntimeBusyError,
  ModuleRuntimeUnavailableError,
  type ModuleRuntime,
  type ModuleRuntimeEnvironment,
  type ModuleRuntimeHooks,
  type ModuleRuntimeStartResult,
  type ModuleRuntimeState,
  type StartModuleRuntimeOptions,
} from "./runtimeTypes";
export { startModuleRuntime } from "./startModuleRuntime";
