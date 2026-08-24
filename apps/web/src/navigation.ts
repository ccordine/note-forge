import type { IconName } from "@/ui/Icon";

export const VIEW_IDS = Object.freeze([
  "home",
  "sound",
  "mirror",
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
  "skills",
] as const);

export type ViewId = typeof VIEW_IDS[number];

const VIEW_ID_SET: ReadonlySet<string> = new Set(VIEW_IDS);

export function isViewId(value: string): value is ViewId {
  return VIEW_ID_SET.has(value);
}

export interface NavigationItem {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: IconName;
}

export interface NavigationGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

function freezeNavigation(groups: readonly NavigationGroup[]): readonly NavigationGroup[] {
  return Object.freeze(groups.map((group) => Object.freeze({
    ...group,
    items: Object.freeze(group.items.map((item) => Object.freeze({ ...item }))),
  })));
}

export const NAVIGATION = freezeNavigation([
  { label: "Forge", items: [
    { id: "home", label: "Overview", icon: "forge" },
    { id: "sound", label: "Sound Laboratory", icon: "sound" },
  ] },
  { label: "Train", items: [
    { id: "mirror", label: "Pitch Mirror", icon: "mirror" },
    { id: "hum", label: "Hum Laboratory", icon: "hum" },
    { id: "range-map", label: "Range Simulator", icon: "loop" },
    { id: "loop", label: "Range Loop", icon: "loop" },
    { id: "arcade", label: "Voice Arcade", icon: "arcade" },
    { id: "control", label: "Pitch & Dynamics", icon: "control" },
    { id: "ear", label: "Note Recognition", icon: "ear" },
    { id: "intervals", label: "Intervals", icon: "interval" },
    { id: "harmony", label: "Harmony", icon: "harmony" },
    { id: "melody", label: "Melody", icon: "melody" },
  ] },
  { label: "Integrate", items: [
    { id: "song", label: "Song Laboratory", icon: "song" },
    { id: "skills", label: "Skill Map", icon: "skills" },
  ] },
] satisfies readonly NavigationGroup[]);

export interface ViewTitle {
  readonly eyebrow: string;
  readonly title: string;
}

function freezeViewTitles(
  titles: Record<ViewId, ViewTitle>,
): Readonly<Record<ViewId, Readonly<ViewTitle>>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(titles).map(([id, title]) => [id, Object.freeze({ ...title })]),
  )) as Readonly<Record<ViewId, Readonly<ViewTitle>>>;
}

export const VIEW_TITLES = freezeViewTitles({
  home: { eyebrow: "NoteForge", title: "The Forge" },
  sound: { eyebrow: "Explore", title: "Sound Laboratory" },
  mirror: { eyebrow: "Produce", title: "Pitch Mirror" },
  hum: { eyebrow: "Produce", title: "Hum Laboratory" },
  "range-map": { eyebrow: "Map", title: "Guided Range Simulator" },
  loop: { eyebrow: "Repeat", title: "Range-Building Loop" },
  arcade: { eyebrow: "Play", title: "Voice Arcade" },
  control: { eyebrow: "Produce", title: "Pitch & Dynamic Control" },
  ear: { eyebrow: "Perceive", title: "Note Recognition" },
  intervals: { eyebrow: "Relate", title: "Interval Laboratory" },
  harmony: { eyebrow: "Understand", title: "Chord & Harmony Laboratory" },
  melody: { eyebrow: "Remember", title: "Melody & Phrase Laboratory" },
  song: { eyebrow: "Integrate", title: "Song Laboratory" },
  skills: { eyebrow: "Navigate", title: "Trainable Skill Graph" },
});
