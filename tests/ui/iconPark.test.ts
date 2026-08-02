// @vitest-environment jsdom

import { Home } from "@icon-park/svg";
import { afterEach, describe, expect, it } from "vitest";

import {
  createIconOnlyButton,
  createIconParkIcon,
} from "../../src/shared/ui";

describe("IconPark DOM helpers", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("creates a decorative icon with shared rendering defaults and class lists", () => {
    const icon = createIconParkIcon(document, Home, {
      classNames: ["shared-icon", "is-compact highlighted"],
    });

    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.getAttribute("width")).toBe("20");
    expect(icon.getAttribute("height")).toBe("20");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("focusable")).toBe("false");
    expect(icon.classList.contains("shared-icon")).toBe(true);
    expect(icon.classList.contains("is-compact")).toBe(true);
    expect(icon.classList.contains("highlighted")).toBe(true);
  });

  it("supports a labelled standalone icon without also hiding it", () => {
    const icon = createIconParkIcon(document, Home, {
      size: 16,
      ariaLabel: "首页",
    });

    expect(icon.getAttribute("width")).toBe("16");
    expect(icon.getAttribute("role")).toBe("img");
    expect(icon.getAttribute("aria-label")).toBe("首页");
    expect(icon.hasAttribute("aria-hidden")).toBe(false);
  });

  it("creates a type-safe icon-only button whose title matches its accessible label", () => {
    const button = createIconOnlyButton(document, Home, "返回首页", {
      classNames: "toolbar-button",
      iconClassNames: "toolbar-icon",
    });

    expect(button.type).toBe("button");
    expect(button.title).toBe("返回首页");
    expect(button.getAttribute("aria-label")).toBe(button.title);
    expect(button.className).toBe("toolbar-button");
    expect(button.querySelector("svg")?.classList.contains("toolbar-icon")).toBe(true);
    expect(() => createIconOnlyButton(document, Home, "  ")).toThrow(
      "requires a non-empty label",
    );
  });
});
