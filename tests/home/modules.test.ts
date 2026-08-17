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

  it("uses mind-maps for both the route and persisted module ID", () => {
    const mindMap = dashboardModuleCatalog.find(
      ({ routeSlug }) => routeSlug === "mind-maps",
    );
    expect(mindMap?.definition?.moduleId).toBe("mind-maps");
    expect(mindMap?.routeSlug).toBe(mindMap?.definition?.moduleId);
    expect(dashboardModules.find(({ id }) => id === "mind-maps")?.href)
      .toBe("modules/mind-maps/");
    expect(getDashboardModuleTitle("mind-maps")).toBe("思维导图");
  });
});
