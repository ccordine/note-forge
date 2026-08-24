import {
  lazy,
  type ComponentType,
  type CSSProperties,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import "../../styles-voice-draw-preview.css";
import "../../styles-vocal-flight-preview.css";
import type {
  ArcadeCurriculumModeCopy,
  ArcadeCurriculumStage,
  ArcadeGameProps,
} from "./types";

interface ArcadeStageMasteryRequirement {
  readonly requiredRuns: number;
  readonly minimumScore: number;
}

interface ArcadeGameDefinition {
  readonly order: number;
  readonly number: string;
  readonly title: string;
  readonly kicker: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly accent: string;
  readonly button: string;
  readonly featuredDetail?: string;
  readonly component: LazyExoticComponent<ComponentType<ArcadeGameProps>>;
  readonly preview: () => ReactNode;
  readonly curriculum: ArcadeCurriculumModeCopy;
  readonly mastery: Readonly<Record<ArcadeCurriculumStage, ArcadeStageMasteryRequirement>>;
}

function gameComponent(
  load: () => Promise<{ default: ComponentType<ArcadeGameProps> }>,
  loadStyles: readonly (() => Promise<unknown>)[],
): LazyExoticComponent<ComponentType<ArcadeGameProps>> {
  return lazy(async () => {
    const [component] = await Promise.all([
      load(),
      ...loadStyles.map((loadStyle) => loadStyle()),
    ]);
    return component;
  });
}

/**
 * The one registration authority for shipped Arcade cabinets. Adding or
 * deleting a game changes one typed definition plus that game's owned files;
 * routing, curriculum, progress, cabinet rendering, and dispatch derive from
 * this registry.
 */
export const ARCADE_GAME_DEFINITIONS = Object.freeze({
  pattern: {
    order: 3,
    number: "03",
    title: "Echo Run",
    kicker: "SIMON × NOTE HIGHWAY",
    description: "Hear a pitch pattern, then drive through the same notes on time. Accuracy, clean transitions, memory, and sustain all feed the combo.",
    skills: ["pitch matching", "interval motion", "rhythm", "memory"],
    accent: "lime",
    button: "Enter the note highway",
    component: gameComponent(
      () => import("./PatternChallenge").then(({ PatternChallenge }) => ({ default: PatternChallenge })),
      [() => import("../../styles-echo-run.css")],
    ),
    preview: () => <div className="arcade-demo-highway">{[0, 1, 2, 3, 4].map((index) => <i key={index} style={{ "--demo-index": index } as CSSProperties} />)}<span /></div>,
    curriculum: {
      focus: "Discrete pitch selection, cold pitch-lock, transitions, and rhythmic placement.",
      cognitiveLoad: "Read the note highway and prepare the next vocal coordinate while the beat keeps moving.",
    },
    mastery: {
      deliberate: { requiredRuns: 2, minimumScore: 72 },
      reflex: { requiredRuns: 3, minimumScore: 80 },
      background: { requiredRuns: 3, minimumScore: 86 },
    },
  },
  pong: {
    order: 1,
    number: "01",
    title: "Pitch Pong",
    kicker: "CONTINUOUS VOICE CONTROL",
    description: "Your sung pitch is the paddle. Glide upward and downward, intercept the ball, and learn to place pitch continuously instead of guessing isolated notes.",
    skills: ["glides", "range navigation", "reaction", "stability"],
    accent: "blue",
    button: "Take the paddle",
    component: gameComponent(
      () => import("./PitchPong").then(({ PitchPong }) => ({ default: PitchPong })),
      [() => import("../../styles-pitch-pong.css")],
    ),
    preview: () => <div className="arcade-demo-pong"><i /><i /><b /><span /></div>,
    curriculum: {
      focus: "Continuous pitch-to-position mapping and controlled fine movement across the vocal range.",
      cognitiveLoad: "Track ball trajectory and interception timing while pitch steering becomes automatic.",
    },
    mastery: {
      deliberate: { requiredRuns: 2, minimumScore: 68 },
      reflex: { requiredRuns: 3, minimumScore: 76 },
      background: { requiredRuns: 3, minimumScore: 82 },
    },
  },
  song: {
    order: 4,
    number: "04",
    title: "Song Rail",
    kicker: "LOCAL MP3 × TARGET LANES",
    description: "Load a local track. NoteForge builds a playable target chart from local pitch and energy cues, fits it to your range, and scores your voice against moving note lanes.",
    skills: ["phrasing", "song context", "timing", "range transfer"],
    accent: "violet",
    button: "Build a song challenge",
    component: gameComponent(
      () => import("./SongRide").then(({ SongRide }) => ({ default: SongRide })),
      [() => import("../../styles-song-ride.css")],
    ),
    preview: () => <div className="arcade-demo-song">{[0.7, 0.35, 0.55, 0.2, 0.65].map((position, index) => <i key={index} style={{ "--demo-note": position, "--demo-time": index } as CSSProperties} />)}<span /></div>,
    curriculum: {
      focus: "Transfer pitch control into phrases, breathing windows, and changing musical context.",
      cognitiveLoad: "Follow the track, anticipate its lane, and preserve vocal control through real phrasing.",
    },
    mastery: {
      deliberate: { requiredRuns: 1, minimumScore: 70 },
      reflex: { requiredRuns: 2, minimumScore: 78 },
      background: { requiredRuns: 2, minimumScore: 84 },
    },
  },
  maze: {
    order: 2,
    number: "02",
    title: "Pitch Maze",
    kicker: "FOUR NOTES × CARDINAL CONTROL",
    description: "Four notes become north, east, south, and west. Hold a direction note until one cell moves, then change pitch or sing again after silence to keep navigating.",
    skills: ["note recall", "pitch fluency", "sustain", "navigation"],
    accent: "orange",
    button: "Enter the pitch maze",
    component: gameComponent(
      () => import("./PitchMaze").then(({ PitchMaze }) => ({ default: PitchMaze })),
      [() => import("../../styles-pitch-maze.css")],
    ),
    preview: () => <div className="arcade-demo-maze"><i /><i /><i /><i /><i /><i /><i /><i /><i /><b /><span /></div>,
    curriculum: {
      focus: "Distinct nearby-note selection, stable sustain, clean release, and deliberate transitions.",
      cognitiveLoad: "Plan a route and remember rotating direction mappings while every move still needs a precise hold.",
    },
    mastery: {
      deliberate: { requiredRuns: 1, minimumScore: 72 },
      reflex: { requiredRuns: 2, minimumScore: 80 },
      background: { requiredRuns: 2, minimumScore: 86 },
    },
  },
  resonance: {
    order: 5,
    number: "05",
    title: "Resonance",
    kicker: "VOICE FIELD × PHYSICS PUZZLES",
    description: "Shape a local acoustic field with stable pitch and normalized voice energy. Guide a ball through resonators, walls, and goals without brute-force volume.",
    skills: ["resonance", "steady force", "pitch discovery", "field control"],
    accent: "amber",
    button: "Enter Resonance",
    component: gameComponent(
      () => import("./Resonance").then(({ Resonance }) => ({ default: Resonance })),
      [() => import("../../styles-resonance.css")],
    ),
    preview: () => <div className="arcade-demo-resonance"><i /><i /><i /><b /><span /></div>,
    curriculum: {
      focus: "Frequency-to-force coupling, steady pitch, controlled intensity, and resonance discovery.",
      cognitiveLoad: "Plan around walls and inertia while maintaining an efficient acoustic field with the voice.",
    },
    mastery: {
      deliberate: { requiredRuns: 1, minimumScore: 70 },
      reflex: { requiredRuns: 2, minimumScore: 78 },
      background: { requiredRuns: 2, minimumScore: 84 },
    },
  },
  draw: {
    order: 6,
    number: "06",
    title: "Vocal Canvas",
    kicker: "EIGHT NOTES × SPATIAL CONTROL",
    description: "Eight neighboring notes steer a live drawing cursor in eight directions. Sing to move, use silence to stop, and turn pitch transitions into lines, shapes, and pictures.",
    skills: ["note fluency", "spatial control", "transitions", "motor planning"],
    accent: "pink",
    button: "Draw with your voice",
    featuredDetail: "Draw with eight sung directions",
    component: gameComponent(
      () => import("./VoiceDraw").then(({ VoiceDraw }) => ({ default: VoiceDraw })),
      [
        () => import("../../styles-voice-draw.css"),
        () => import("../../styles-voice-draw-responsive.css"),
      ],
    ),
    preview: () => <div className="arcade-demo-draw" aria-hidden="true"><svg viewBox="0 0 240 160"><path d="M28 128 L62 88 L98 112 L137 55 L181 73 L211 34" /><circle cx="211" cy="34" r="7" /><text x="136" y="28">G3 ↗</text></svg></div>,
    curriculum: {
      focus: "Eight-direction pitch-to-motion mapping, clean directional changes, stable holds, and deliberate line placement.",
      cognitiveLoad: "Plan recognizable lines and shapes while the eight-note direction bank recedes into background controller fluency.",
    },
    mastery: {
      deliberate: { requiredRuns: 1, minimumScore: 70 },
      reflex: { requiredRuns: 2, minimumScore: 78 },
      background: { requiredRuns: 2, minimumScore: 84 },
    },
  },
  flight: {
    order: 7,
    number: "07",
    title: "Vocal Flight",
    kicker: "VOICE VECTOR × ARCADE FLIGHT",
    description: "Calibrate a neutral vocal center, then steer continuously with relative pitch and brightness. Fine acoustic corrections become climb, bank, recovery, and flight-path control.",
    skills: ["fine pitch", "resonance control", "axis independence", "center recovery"],
    accent: "cyan",
    button: "Take vocal control",
    component: gameComponent(
      () => import("./vocal-flight/VocalFlight").then(({ VocalFlight }) => ({ default: VocalFlight })),
      [
        () => import("../../styles-vocal-flight.css"),
        () => import("../../styles-vocal-flight-responsive.css"),
      ],
    ),
    preview: () => (
      <div className="arcade-demo-flight" aria-hidden="true">
        <i /><i /><i />
        <b />
        <span />
      </div>
    ),
    curriculum: {
      focus: "Independent continuous pitch, brightness, and neutral-recovery control around a personalized vocal center.",
      cognitiveLoad: "Read the course and fly its path while the acoustic control vector recedes from conscious attention.",
    },
    mastery: {
      deliberate: { requiredRuns: 2, minimumScore: 68 },
      reflex: { requiredRuns: 3, minimumScore: 76 },
      background: { requiredRuns: 3, minimumScore: 84 },
    },
  },
} satisfies Readonly<Record<string, ArcadeGameDefinition>>);

export type ArcadeMode = keyof typeof ARCADE_GAME_DEFINITIONS;
export const ARCADE_MODES = Object.freeze(
  Object.keys(ARCADE_GAME_DEFINITIONS) as ArcadeMode[],
);
export const ARCADE_MODE_ORDER = Object.freeze(
  [...ARCADE_MODES].sort((left, right) => (
    ARCADE_GAME_DEFINITIONS[left].order - ARCADE_GAME_DEFINITIONS[right].order
  )),
);
const featuredMode = ARCADE_MODES.find((mode) => (
  "featuredDetail" in ARCADE_GAME_DEFINITIONS[mode]
)) ?? ARCADE_MODE_ORDER[0]!;
const featuredDefinition: ArcadeGameDefinition = ARCADE_GAME_DEFINITIONS[featuredMode];
export const ARCADE_FEATURED_GAME = Object.freeze({
  mode: featuredMode,
  title: featuredDefinition.title,
  detail: featuredDefinition.featuredDetail ?? featuredDefinition.description,
});
