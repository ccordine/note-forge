import { describe, expect, it } from "vitest";

import {
  ALL_APP_ROUTES,
  APP_SCREEN_IDS,
  DEFAULT_ROUTES,
  NAVIGATION,
  PAGE_TITLES,
  PRACTICE_ACTIVITIES,
  PRODUCT_SURFACES,
  appRoutePath,
  appRouteScreen,
} from "../apps/web/src/navigation";
import { matchAppRoute } from "../apps/web/src/routing/use-app-navigation";

describe("typed product routes", () => {
  it("publishes 52 exact, unique, router-matched activity paths", () => {
    const paths = ALL_APP_ROUTES.map(appRoutePath);
    expect(paths).toHaveLength(52);
    expect(new Set(paths).size).toBe(paths.length);
    for (const route of ALL_APP_ROUTES) {
      expect(matchAppRoute(appRoutePath(route))).toEqual(route);
    }
  });

  it("uses the five product surfaces as URL authority", () => {
    expect(appRoutePath(DEFAULT_ROUTES.home)).toBe("/");
    expect(appRoutePath(DEFAULT_ROUTES.pitchMatch)).toBe("/practice/pitch-match/glide");
    expect(appRoutePath(DEFAULT_ROUTES.arcade)).toBe("/arcade");
    expect(appRoutePath(DEFAULT_ROUTES.sound)).toBe("/explore/sound/dyad");
    expect(appRoutePath(DEFAULT_ROUTES.songs)).toBe("/songs/lab");
    expect(appRoutePath(DEFAULT_ROUTES.rangeMap)).toBe("/progress/range-map");
  });

  it.each([
    "/home",
    "/mirror/cold",
    "/hum/anchor",
    "/loop",
    "/range-map",
    "/sound/dyad",
    "/song",
    "/skills",
    "/practice",
    "/arcade/cabinet",
    "/practice/pitch-match/unknown",
    "/practice/intervals/production/extra",
    "/PRACTICE/pitch-match/cold",
  ])("rejects retired or non-canonical path %s", (path) => {
    expect(matchAppRoute(path)).toBeNull();
  });

  it("derives internal render targets without making them top-level products", () => {
    expect(appRouteScreen({ surface: "practice", activity: "pitch-match", mode: "cold" })).toBe("mirror");
    expect(appRouteScreen({ surface: "progress", activity: "range-map" })).toBe("range-map");
    expect(appRouteScreen({ surface: "songs", activity: "lab" })).toBe("song");
    expect([...Object.keys(PAGE_TITLES)].sort()).toEqual([...APP_SCREEN_IDS].sort());
  });
});

describe("product information architecture", () => {
  it("publishes exactly five permanent user-job destinations", () => {
    expect(NAVIGATION).toHaveLength(5);
    expect(NAVIGATION.map((item) => item.surface)).toEqual(PRODUCT_SURFACES);
    expect(NAVIGATION.map((item) => item.label)).toEqual([
      "Practice",
      "Arcade",
      "Explore",
      "Songs",
      "Progress",
    ]);
  });

  it("keeps training capabilities inside the Practice surface", () => {
    expect(PRACTICE_ACTIVITIES.map((activity) => activity.id)).toEqual([
      "pitch-match",
      "pitch-tunnel",
      "hum",
      "range-loop",
      "pitch-control",
      "note-recognition",
      "intervals",
      "harmony",
      "melody",
    ]);
    expect(PRACTICE_ACTIVITIES.every((activity) => activity.route.surface === "practice")).toBe(true);
  });
});
