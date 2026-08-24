import type { IconName } from "@/ui/Icon";
import {
  ARCADE_MODES,
  type ArcadeMode,
} from "@/features/voice-arcade/arcade-registry";

export const PRODUCT_SURFACES = Object.freeze([
  "practice",
  "arcade",
  "explore",
  "songs",
  "progress",
] as const);

export type ProductSurface = typeof PRODUCT_SURFACES[number];
export type SoundMode = "note" | "dyad" | "chord";
export type MirrorMode = "glide" | "delayed" | "cold" | "anchor" | "silent";
export type HumMode = "anchor" | "match" | "glide" | "sustain";
export type ControlMode = "free" | "steady" | "crescendo" | "decrescendo" | "diamond" | "pulses";
export type EarMode = "letters" | "reference" | "same-different" | "direction" | "pitch-class" | "octave" | "complete" | "family";
export type IntervalMode = "recognition" | "production" | "comparison" | "mutation";
export type HarmonyMode = "scale-degree-recognition" | "scale-degree-production" | "chord-tone" | "voice-leading" | "harmony-follow";
export type MelodyMode = "echo" | "contour" | "draw" | "transcribe";
export type ArcadeRouteMode = ArcadeMode;

export type AppRoute =
  | Readonly<{ surface: "home" }>
  | Readonly<{ surface: "explore"; activity: "sound"; mode: SoundMode }>
  | Readonly<{ surface: "practice"; activity: "pitch-match"; mode: MirrorMode }>
  | Readonly<{ surface: "practice"; activity: "pitch-tunnel" }>
  | Readonly<{ surface: "practice"; activity: "hum"; mode: HumMode }>
  | Readonly<{ surface: "practice"; activity: "range-loop" }>
  | Readonly<{ surface: "practice"; activity: "pitch-control"; mode: ControlMode }>
  | Readonly<{ surface: "practice"; activity: "note-recognition"; mode: EarMode }>
  | Readonly<{ surface: "practice"; activity: "intervals"; mode: IntervalMode }>
  | Readonly<{ surface: "practice"; activity: "harmony"; mode: HarmonyMode }>
  | Readonly<{ surface: "practice"; activity: "melody"; mode: MelodyMode }>
  | Readonly<{ surface: "arcade"; activity: "cabinet" }>
  | Readonly<{ surface: "arcade"; activity: ArcadeRouteMode }>
  | Readonly<{ surface: "songs"; activity: "lab" }>
  | Readonly<{ surface: "progress"; activity: "range-map" }>;

export const APP_SCREEN_IDS = Object.freeze([
  "home",
  "sound",
  "mirror",
  "tunnel",
  "hum",
  "range-map",
  "loop",
  "arcade",
  "control",
  "ear",
  "intervals",
  "harmony",
  "melody",
  "song",
] as const);

export type AppScreenId = typeof APP_SCREEN_IDS[number];

const freezeRoute = <Route extends AppRoute>(route: Route): Readonly<Route> => Object.freeze(route);

export const DEFAULT_ROUTES = Object.freeze({
  home: freezeRoute({ surface: "home" } as const),
  sound: freezeRoute({ surface: "explore", activity: "sound", mode: "dyad" } as const),
  pitchMatch: freezeRoute({ surface: "practice", activity: "pitch-match", mode: "glide" } as const),
  pitchTunnel: freezeRoute({ surface: "practice", activity: "pitch-tunnel" } as const),
  hum: freezeRoute({ surface: "practice", activity: "hum", mode: "anchor" } as const),
  rangeLoop: freezeRoute({ surface: "practice", activity: "range-loop" } as const),
  pitchControl: freezeRoute({ surface: "practice", activity: "pitch-control", mode: "diamond" } as const),
  noteRecognition: freezeRoute({ surface: "practice", activity: "note-recognition", mode: "letters" } as const),
  intervals: freezeRoute({ surface: "practice", activity: "intervals", mode: "recognition" } as const),
  harmony: freezeRoute({ surface: "practice", activity: "harmony", mode: "chord-tone" } as const),
  melody: freezeRoute({ surface: "practice", activity: "melody", mode: "echo" } as const),
  arcade: freezeRoute({ surface: "arcade", activity: "cabinet" } as const),
  songs: freezeRoute({ surface: "songs", activity: "lab" } as const),
  rangeMap: freezeRoute({ surface: "progress", activity: "range-map" } as const),
} satisfies Record<string, AppRoute>);

function routesWithMode<Mode extends string>(
  makeRoute: (mode: Mode) => AppRoute,
  modes: readonly Mode[],
): readonly AppRoute[] {
  return modes.map((mode) => freezeRoute(makeRoute(mode)));
}

export const ALL_APP_ROUTES: readonly AppRoute[] = Object.freeze([
  DEFAULT_ROUTES.home,
  ...routesWithMode((mode: SoundMode) => ({ surface: "explore", activity: "sound", mode }), ["note", "dyad", "chord"]),
  ...routesWithMode((mode: MirrorMode) => ({ surface: "practice", activity: "pitch-match", mode }), ["glide", "delayed", "cold", "anchor", "silent"]),
  DEFAULT_ROUTES.pitchTunnel,
  ...routesWithMode((mode: HumMode) => ({ surface: "practice", activity: "hum", mode }), ["anchor", "match", "glide", "sustain"]),
  DEFAULT_ROUTES.rangeLoop,
  ...routesWithMode((mode: ControlMode) => ({ surface: "practice", activity: "pitch-control", mode }), ["free", "steady", "crescendo", "decrescendo", "diamond", "pulses"]),
  ...routesWithMode((mode: EarMode) => ({ surface: "practice", activity: "note-recognition", mode }), ["letters", "reference", "same-different", "direction", "pitch-class", "octave", "complete", "family"]),
  ...routesWithMode((mode: IntervalMode) => ({ surface: "practice", activity: "intervals", mode }), ["recognition", "production", "comparison", "mutation"]),
  ...routesWithMode((mode: HarmonyMode) => ({ surface: "practice", activity: "harmony", mode }), ["scale-degree-recognition", "scale-degree-production", "chord-tone", "voice-leading", "harmony-follow"]),
  ...routesWithMode((mode: MelodyMode) => ({ surface: "practice", activity: "melody", mode }), ["echo", "contour", "draw", "transcribe"]),
  DEFAULT_ROUTES.arcade,
  ...routesWithMode((activity: ArcadeRouteMode) => ({ surface: "arcade", activity }), ARCADE_MODES),
  DEFAULT_ROUTES.songs,
  DEFAULT_ROUTES.rangeMap,
]);

export function appRoutePath(route: AppRoute): string {
  switch (route.surface) {
    case "home": return "/";
    case "explore": return `/explore/sound/${route.mode}`;
    case "songs": return "/songs/lab";
    case "progress": return "/progress/range-map";
    case "arcade": return route.activity === "cabinet" ? "/arcade" : `/arcade/${route.activity}`;
    case "practice":
      switch (route.activity) {
        case "range-loop": return "/practice/range-loop";
        case "pitch-tunnel": return "/practice/pitch-tunnel";
        case "pitch-match": return `/practice/pitch-match/${route.mode}`;
        case "hum": return `/practice/hum/${route.mode}`;
        case "pitch-control": return `/practice/pitch-control/${route.mode}`;
        case "note-recognition": return `/practice/note-recognition/${route.mode}`;
        case "intervals": return `/practice/intervals/${route.mode}`;
        case "harmony": return `/practice/harmony/${route.mode}`;
        case "melody": return `/practice/melody/${route.mode}`;
      }
  }
}

export function appRouteScreen(route: AppRoute): AppScreenId {
  switch (route.surface) {
    case "home": return "home";
    case "explore": return "sound";
    case "arcade": return "arcade";
    case "songs": return "song";
    case "progress": return "range-map";
    case "practice":
      switch (route.activity) {
        case "pitch-match": return "mirror";
        case "pitch-tunnel": return "tunnel";
        case "hum": return "hum";
        case "range-loop": return "loop";
        case "pitch-control": return "control";
        case "note-recognition": return "ear";
        case "intervals": return "intervals";
        case "harmony": return "harmony";
        case "melody": return "melody";
      }
  }
}

export type PracticeActivity = Extract<AppRoute, { surface: "practice" }>["activity"];

export interface PracticeActivityItem {
  readonly id: PracticeActivity;
  readonly label: string;
  readonly route: Extract<AppRoute, { surface: "practice" }>;
}

export const PRACTICE_ACTIVITIES = Object.freeze([
  { id: "pitch-match", label: "Pitch match", route: DEFAULT_ROUTES.pitchMatch },
  { id: "pitch-tunnel", label: "Pitch tunnel", route: DEFAULT_ROUTES.pitchTunnel },
  { id: "hum", label: "Hum", route: DEFAULT_ROUTES.hum },
  { id: "range-loop", label: "Range loop", route: DEFAULT_ROUTES.rangeLoop },
  { id: "pitch-control", label: "Pitch & dynamics", route: DEFAULT_ROUTES.pitchControl },
  { id: "note-recognition", label: "Note recognition", route: DEFAULT_ROUTES.noteRecognition },
  { id: "intervals", label: "Intervals", route: DEFAULT_ROUTES.intervals },
  { id: "harmony", label: "Harmony", route: DEFAULT_ROUTES.harmony },
  { id: "melody", label: "Melody", route: DEFAULT_ROUTES.melody },
] satisfies readonly PracticeActivityItem[]);

export interface NavigationItem {
  readonly surface: ProductSurface;
  readonly route: Exclude<AppRoute, { surface: "home" }>;
  readonly label: string;
  readonly icon: IconName;
}

export const NAVIGATION = Object.freeze([
  { surface: "practice", route: DEFAULT_ROUTES.pitchMatch, label: "Practice", icon: "mirror" },
  { surface: "arcade", route: DEFAULT_ROUTES.arcade, label: "Arcade", icon: "arcade" },
  { surface: "explore", route: DEFAULT_ROUTES.sound, label: "Explore", icon: "sound" },
  { surface: "songs", route: DEFAULT_ROUTES.songs, label: "Songs", icon: "song" },
  { surface: "progress", route: DEFAULT_ROUTES.rangeMap, label: "Progress", icon: "loop" },
] satisfies readonly NavigationItem[]);

export interface PageTitle {
  readonly eyebrow: string;
  readonly title: string;
}

export const PAGE_TITLES: Readonly<Record<AppScreenId, Readonly<PageTitle>>> = Object.freeze({
  home: Object.freeze({ eyebrow: "NoteForge", title: "The Forge" }),
  sound: Object.freeze({ eyebrow: "Explore", title: "Sound Laboratory" }),
  mirror: Object.freeze({ eyebrow: "Practice", title: "Pitch Match" }),
  tunnel: Object.freeze({ eyebrow: "Practice", title: "Pitch Tunnel" }),
  hum: Object.freeze({ eyebrow: "Practice", title: "Hum Laboratory" }),
  "range-map": Object.freeze({ eyebrow: "Progress", title: "Vocal Range Map" }),
  loop: Object.freeze({ eyebrow: "Practice", title: "Range-Building Loop" }),
  arcade: Object.freeze({ eyebrow: "Arcade", title: "Voice Arcade" }),
  control: Object.freeze({ eyebrow: "Practice", title: "Pitch & Dynamic Control" }),
  ear: Object.freeze({ eyebrow: "Practice", title: "Note Recognition" }),
  intervals: Object.freeze({ eyebrow: "Practice", title: "Interval Laboratory" }),
  harmony: Object.freeze({ eyebrow: "Practice", title: "Chord & Harmony Laboratory" }),
  melody: Object.freeze({ eyebrow: "Practice", title: "Melody & Phrase Laboratory" }),
  song: Object.freeze({ eyebrow: "Songs", title: "Song Laboratory" }),
});
