import { describe, expect, it } from "vitest";
import { focusLeftPopover } from "../apps/web/components/ui/usePopover";

// F11 review: the account menu and the bell panel close when keyboard focus leaves them.

const inside = { nodeType: 1, name: "Log out button" };
const outside = { nodeType: 1, name: "a link after the menu" };
const wrapper = { contains: (node: Node | null) => node === (inside as unknown as Node) };

describe("focusLeftPopover", () => {
  it("focus moved to an element outside → close", () => {
    expect(focusLeftPopover(wrapper, outside as unknown as EventTarget)).toBe(true);
  });

  it("focus moved to another element inside (e.g. My videos → Log out) → stay open", () => {
    expect(focusLeftPopover(wrapper, inside as unknown as EventTarget)).toBe(false);
  });

  it("focus went nowhere (click on plain text in the panel, window lost focus) → stay open", () => {
    expect(focusLeftPopover(wrapper, null)).toBe(false);
  });

  it("no wrapper yet, or something that isn't a page element → stay open", () => {
    expect(focusLeftPopover(null, outside as unknown as EventTarget)).toBe(false);
    expect(focusLeftPopover(wrapper, {} as EventTarget)).toBe(false);
  });
});
