import { fragmentThoughtsDefinition } from "../fragment-thoughts/definition";
import { mindMapDefinition } from "../mind-maps/definition";
import type { ModuleDefinition } from "../shared/sync";
import { todosDefinition } from "../todos/definition";

export interface DashboardModule {
  id: string;
  title: string;
  description: string;
  href: string;
}

export interface DashboardModuleCatalogEntry {
  readonly routeSlug: string;
  readonly title: string;
  readonly description: string;
  readonly definition?: ModuleDefinition<unknown, unknown>;
}

/** The single inventory for the home page and persistent-module setup. */
export const dashboardModuleCatalog = [
  {
    routeSlug: "todos",
    title: "待办",
    description: "用递进任务、周期规则和加权进度管理复杂事项。",
    definition: eraseDefinition(todosDefinition),
  },
  {
    routeSlug: "mind-maps",
    title: "思维导图",
    description: "管理多级导图库，在自由画布中整理文字并建立连接。",
    definition: eraseDefinition(mindMapDefinition),
  },
  {
    routeSlug: "fragment-thoughts",
    title: "碎片想法",
    description: "随手记录零散想法，并通过搜索和版本历史回顾变化。",
    definition: eraseDefinition(fragmentThoughtsDefinition),
  },
] as const satisfies readonly DashboardModuleCatalogEntry[];

/** Compatibility projection consumed by the existing home view. */
export const dashboardModules: DashboardModule[] = dashboardModuleCatalog.map(
  ({ routeSlug, title, description }) => ({
    id: routeSlug,
    title,
    description,
    href: `modules/${routeSlug}/`,
  }),
);

/** Compatibility projection consumed by first-account setup. */
export const persistentDashboardDefinitions = dashboardModuleCatalog.flatMap(
  ({ definition }) => definition ? [definition] : [],
);

export function getDashboardModuleTitle(moduleIdOrRouteSlug: string): string | null {
  return dashboardModuleCatalog.find(({ routeSlug, definition }) =>
    routeSlug === moduleIdOrRouteSlug || definition?.moduleId === moduleIdOrRouteSlug
  )?.title ?? null;
}

function eraseDefinition<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
): ModuleDefinition<unknown, unknown> {
  return definition as unknown as ModuleDefinition<unknown, unknown>;
}
