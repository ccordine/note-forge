import { describe, expect, it } from "vitest";

import { NAVIGATION, VIEW_TITLES } from "../apps/web/src/navigation";

describe("primary navigation", () => {
  it("publishes both range workflows in the Train group", () => {
    const train = NAVIGATION.find((group) => group.label === "Train");

    expect(train?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "range-map", label: "Range Simulator" }),
      expect.objectContaining({ id: "loop", label: "Range Loop" }),
      expect.objectContaining({ id: "arcade", label: "Voice Arcade" }),
    ]));
    expect(VIEW_TITLES["range-map"].title).toBe("Guided Range Simulator");
    expect(VIEW_TITLES.loop.title).toBe("Range-Building Loop");
    expect(VIEW_TITLES.arcade.title).toBe("Voice Arcade");
  });

  it("contains every view exactly once", () => {
    const ids = NAVIGATION.flatMap((group) => group.items.map((item) => item.id));

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...Object.keys(VIEW_TITLES)].sort());
  });
});
