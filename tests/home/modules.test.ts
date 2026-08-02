import { describe, expect, it } from "vitest";

import {
  dashboardModuleCatalog,
  dashboardModules,
  getDashboardModuleTitle,
  persistentDashboardDefinitions,
} from "../../src/home/modules";

describe("dashboard module catalog", () => {
  it("derives navigation and persistent definitions from one inventory", () => {
    expect(dashboardModules).toEqual(
      dashboardModuleCatalog.map(({ routeSlug, title, description }) => ({
        id: routeSlug,
        title,
        description,
        href: `modules/${routeSlug}/`,
      })),
    );
    expect(persistentDashboardDefinitions).toEqual(
      dashboardModuleCatalog.flatMap(({ definition }) =>
        definition ? [definition] : []),
    );
    expect(new Set(persistentDashboardDefinitions.map(({ moduleId }) => moduleId)).size)
      .toBe(persistentDashboardDefinitions.length);
  });

  it("keeps the mind-map route distinct from the mind-maps data ID", () => {
    const mindMap = dashboardModuleCatalog.find(
      ({ routeSlug }) => routeSlug === "mind-map",
    );
    expect(mindMap?.definition?.moduleId).toBe("mind-maps");
    expect(dashboardModules.find(({ id }) => id === "mind-map")?.href)
      .toBe("modules/mind-map/");
    expect(getDashboardModuleTitle("mind-map")).toBe("思维导图");
    expect(getDashboardModuleTitle("mind-maps")).toBe("思维导图");
  });
});
