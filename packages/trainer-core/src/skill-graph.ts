import type { SkillDefinition, SkillGraphValidation, SkillState } from "./types";

const skill = (
  skillId: string,
  label: string,
  description: string,
  domain: SkillDefinition["domain"],
  representations: SkillDefinition["representations"],
  prerequisites: string[],
  difficulty: number,
  tags: string[],
): SkillDefinition => ({
  skillId,
  label,
  description,
  domain,
  representations,
  prerequisites,
  difficulty,
  tags,
});

/**
 * The default graph is deliberately made of reusable abilities, not ordered
 * lessons. Prerequisites describe useful supporting abilities; they do not
 * prevent an application from exposing any laboratory mode directly.
 */
export const SKILL_CATALOG: readonly SkillDefinition[] = [
  // Perception
  skill(
    "pitch.same_different",
    "Same or different pitch",
    "Discriminate whether two sounds share a pitch.",
    "perception",
    ["heard-sound"],
    [],
    0.05,
    ["pitch", "discrimination"],
  ),
  skill(
    "pitch.direction",
    "Higher or lower",
    "Hear the direction of motion between pitches.",
    "perception",
    ["heard-sound"],
    ["pitch.same_different"],
    0.08,
    ["pitch", "direction"],
  ),
  skill(
    "pitch.distance",
    "Approximate pitch distance",
    "Compare the approximate size of pitch movements before naming intervals.",
    "perception",
    ["heard-sound"],
    ["pitch.direction"],
    0.14,
    ["pitch", "distance"],
  ),
  skill(
    "pitch.octave_equivalence",
    "Octave equivalence",
    "Recognize one pitch class across different registers.",
    "perception",
    ["heard-sound", "musical-label"],
    ["pitch.distance"],
    0.2,
    ["pitch", "octave", "pitch-class"],
  ),
  skill(
    "interval.recognize",
    "Relative interval recognition",
    "Identify melodic and harmonic pitch relationships independent of transposition.",
    "perception",
    ["heard-sound", "musical-label"],
    ["pitch.distance", "pitch.octave_equivalence"],
    0.3,
    ["interval", "relative-pitch"],
  ),
  skill(
    "pitch.absolute.pitch_class",
    "Pitch-class recognition",
    "Attach a note name to a heard pitch independently of register.",
    "perception",
    ["heard-sound", "musical-label"],
    ["pitch.octave_equivalence"],
    0.38,
    ["pitch", "absolute", "pitch-class"],
  ),
  skill(
    "pitch.absolute.note_octave",
    "Specific note and octave",
    "Identify both pitch class and register, such as F-sharp 3.",
    "perception",
    ["heard-sound", "musical-label"],
    ["pitch.absolute.pitch_class", "pitch.octave_equivalence"],
    0.5,
    ["pitch", "absolute", "octave"],
  ),
  skill(
    "tonal_center.recognize",
    "Tonal-center recognition",
    "Hear the pitch that functions as home after a drone, scale, or cadence.",
    "perception",
    ["heard-sound", "harmonic-function"],
    ["interval.recognize"],
    0.36,
    ["tonic", "tonality"],
  ),
  skill(
    "scale_degree.recognize",
    "Scale-degree recognition",
    "Hear a note as a chromatic or diatonic degree relative to a tonic.",
    "perception",
    ["heard-sound", "musical-label", "harmonic-function"],
    ["tonal_center.recognize", "interval.recognize"],
    0.44,
    ["scale-degree", "relative-pitch"],
  ),
  skill(
    "chord_tone.recognize",
    "Chord-tone recognition",
    "Hear whether a note is a root, chord member, extension, or non-chord tone.",
    "perception",
    ["heard-sound", "musical-label", "harmonic-function"],
    ["scale_degree.recognize"],
    0.5,
    ["chord", "chord-tone"],
  ),
  skill(
    "chord.recognize.quality_inversion",
    "Chord quality and inversion",
    "Identify chord quality, root, and bass-note inversion.",
    "perception",
    ["heard-sound", "musical-label", "harmonic-function"],
    ["chord_tone.recognize", "interval.recognize"],
    0.58,
    ["chord", "quality", "inversion"],
  ),
  skill(
    "harmony.function.recognize",
    "Harmonic function",
    "Hear chords and tones as tonic, predominant, dominant, or contextual alternatives.",
    "perception",
    ["heard-sound", "harmonic-function"],
    ["tonal_center.recognize", "chord.recognize.quality_inversion"],
    0.68,
    ["harmony", "function"],
  ),
  skill(
    "melody.contour.recognize",
    "Melody and contour",
    "Retain and identify phrase shape, note sequence, and salient leaps.",
    "perception",
    ["heard-sound", "musical-label"],
    ["pitch.direction", "pitch.distance"],
    0.4,
    ["melody", "contour", "memory"],
  ),
  skill(
    "harmony.tension_resolution.recognize",
    "Intentional tension and resolution",
    "Hear contextual tension without treating every non-chord tone as an error.",
    "perception",
    ["heard-sound", "harmonic-function"],
    ["scale_degree.recognize", "chord_tone.recognize", "harmony.function.recognize"],
    0.7,
    ["harmony", "tension", "resolution"],
  ),

  // Production
  skill(
    "hum.anchor.discover",
    "Discover a comfortable hum anchor",
    "Find a relaxed humming pitch and return to the same self-selected center reproducibly.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["pitch.same_different"],
    0.08,
    ["hum", "anchor", "proprioception"],
  ),
  skill(
    "pitch.match.glide",
    "Glide to a target",
    "Steer continuous vocal pitch into a sounded target lane.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["pitch.direction"],
    0.1,
    ["pitch", "matching", "glide"],
  ),
  skill(
    "hum.target.match",
    "Match a target by humming",
    "Use a hum gesture to steer to and center on an externally sounded pitch.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["hum.anchor.discover", "pitch.match.glide"],
    0.16,
    ["hum", "pitch", "matching", "mechanics"],
  ),
  skill(
    "pitch.match.cold_attack",
    "Start directly on a target",
    "Predict vocal configuration and begin near the target without a scoop.",
    "production",
    ["heard-sound", "vocal-mechanics", "musical-label"],
    ["pitch.match.glide"],
    0.3,
    ["pitch", "matching", "attack"],
  ),
  skill(
    "pitch.hold.stability",
    "Hold a target",
    "Sustain a centered fundamental while observing drift, instability, and vibrato.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["pitch.match.glide"],
    0.22,
    ["pitch", "sustain", "stability"],
  ),
  skill(
    "hum.sustain.control",
    "Sustain and control a hum",
    "Hold a centered hum while observing pitch stability, voiced continuity, drift, and release as separate evidence.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["hum.target.match", "pitch.hold.stability"],
    0.28,
    ["hum", "sustain", "stability", "continuity"],
  ),
  skill(
    "pitch.hold.dynamics",
    "Hold pitch through dynamics",
    "Change loudness, vowel, or phonation while keeping pitch independently controlled.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["pitch.hold.stability"],
    0.36,
    ["pitch", "dynamics", "volume"],
  ),
  skill(
    "pitch.transition",
    "Move between two notes",
    "Deliberately connect two pitch centers with controlled onset and arrival.",
    "production",
    ["heard-sound", "vocal-mechanics"],
    ["pitch.hold.stability", "pitch.direction"],
    0.3,
    ["pitch", "transition"],
  ),
  skill(
    "interval.produce",
    "Reproduce an interval",
    "Produce a requested interval above or below a starting note.",
    "production",
    ["heard-sound", "vocal-mechanics", "musical-label"],
    ["pitch.transition", "interval.recognize"],
    0.42,
    ["interval", "production"],
  ),
  skill(
    "scale_degree.produce",
    "Sing a scale degree",
    "Produce a requested diatonic or chromatic degree against an established tonic.",
    "production",
    ["heard-sound", "vocal-mechanics", "musical-label", "harmonic-function"],
    ["interval.produce", "scale_degree.recognize"],
    0.5,
    ["scale-degree", "production"],
  ),
  skill(
    "chord_tone.produce",
    "Sing a chord tone",
    "Target roots, thirds, fifths, sevenths, or tensions in a sounding chord.",
    "production",
    ["heard-sound", "vocal-mechanics", "musical-label", "harmonic-function"],
    ["scale_degree.produce", "chord_tone.recognize"],
    0.58,
    ["chord", "chord-tone", "production"],
  ),
  skill(
    "melody.echo",
    "Reproduce short melodies",
    "Retain and reproduce multi-note phrases with pitch and contour intact.",
    "production",
    ["heard-sound", "vocal-mechanics", "musical-label"],
    ["pitch.transition", "melody.contour.recognize"],
    0.5,
    ["melody", "echo", "memory"],
  ),
  skill(
    "harmony.follow",
    "Sing harmony",
    "Create a chord-aware line rather than merely copying or shifting the melody.",
    "production",
    ["heard-sound", "vocal-mechanics", "harmonic-function"],
    ["chord_tone.produce", "melody.echo"],
    0.68,
    ["harmony", "voice-leading"],
  ),
  skill(
    "harmony.improvise",
    "Improvise in harmonic context",
    "Choose stable tones, passing tones, approaches, tension, and resolution deliberately.",
    "production",
    ["heard-sound", "vocal-mechanics", "harmonic-function"],
    ["harmony.follow", "harmony.tension_resolution.recognize"],
    0.78,
    ["improvisation", "harmony", "voice-leading"],
  ),
  skill(
    "pitch.microtonal.produce",
    "Produce bends and in-between pitches",
    "Control scoops, bends, blue notes, and intentional pitch offsets without snapping.",
    "production",
    ["heard-sound", "vocal-mechanics", "musical-label"],
    ["pitch.match.glide", "pitch.distance"],
    0.55,
    ["microtonal", "bend", "pitch"],
  ),

  // Symbolic mapping
  skill(
    "mapping.note_name",
    "Sound to note name",
    "Connect a heard or produced pitch with its enharmonic note label.",
    "symbolic",
    ["heard-sound", "vocal-mechanics", "musical-label"],
    ["pitch.absolute.pitch_class"],
    0.34,
    ["mapping", "note-name"],
  ),
  skill(
    "mapping.octave",
    "Sound to octave",
    "Connect register with scientific pitch notation.",
    "symbolic",
    ["heard-sound", "musical-label"],
    ["pitch.octave_equivalence"],
    0.38,
    ["mapping", "octave"],
  ),
  skill(
    "mapping.frequency",
    "Pitch to frequency",
    "Navigate between continuous frequency, MIDI coordinate, and cents offset.",
    "symbolic",
    ["heard-sound", "musical-label"],
    ["mapping.note_name", "mapping.octave"],
    0.45,
    ["mapping", "frequency", "cents"],
  ),
  skill(
    "mapping.scale_position",
    "Pitch to scale position",
    "Connect the same note with its degree in the active scale.",
    "symbolic",
    ["heard-sound", "musical-label", "harmonic-function"],
    ["scale_degree.recognize", "mapping.note_name"],
    0.48,
    ["mapping", "scale-degree"],
  ),
  skill(
    "mapping.chord_position",
    "Pitch to chord position",
    "Connect the same note with its role or extension in the active chord.",
    "symbolic",
    ["heard-sound", "musical-label", "harmonic-function"],
    ["chord_tone.recognize", "mapping.note_name"],
    0.52,
    ["mapping", "chord-tone"],
  ),
  skill(
    "mapping.preceding_interval",
    "Pitch to preceding relationship",
    "Name and reproduce how a note relates to the preceding pitch.",
    "symbolic",
    ["heard-sound", "vocal-mechanics", "musical-label"],
    ["interval.recognize", "interval.produce"],
    0.5,
    ["mapping", "interval", "melody"],
  ),

  // Spatial mapping
  skill(
    "mapping.keyboard_position",
    "Pitch to piano key",
    "Locate the heard, sung, or labeled note on a keyboard.",
    "spatial",
    ["heard-sound", "musical-label", "instrument-space"],
    ["mapping.note_name", "mapping.octave"],
    0.35,
    ["mapping", "keyboard", "piano"],
  ),
  skill(
    "mapping.guitar_position",
    "Pitch to guitar position",
    "Locate equivalent positions for the note on a guitar fretboard.",
    "spatial",
    ["heard-sound", "musical-label", "instrument-space"],
    ["mapping.note_name", "mapping.octave"],
    0.45,
    ["mapping", "guitar", "fretboard"],
  ),
  skill(
    "mapping.bass_position",
    "Pitch to bass position",
    "Locate equivalent positions for the note on a bass fretboard.",
    "spatial",
    ["heard-sound", "musical-label", "instrument-space"],
    ["mapping.note_name", "mapping.octave"],
    0.42,
    ["mapping", "bass", "fretboard"],
  ),
];

export const SKILL_DEFINITIONS = SKILL_CATALOG;

export interface SkillGraphNode {
  definition: SkillDefinition;
  dependents: string[];
}

const createGraph = (definitions: readonly SkillDefinition[]): Readonly<Record<string, SkillGraphNode>> => {
  const graph: Record<string, SkillGraphNode> = {};
  for (const definition of definitions) {
    graph[definition.skillId] = { definition, dependents: [] };
  }
  for (const definition of definitions) {
    for (const prerequisite of definition.prerequisites) {
      if (graph[prerequisite]) graph[prerequisite].dependents.push(definition.skillId);
    }
  }
  return graph;
};

export const SKILL_GRAPH = createGraph(SKILL_CATALOG);

export const getSkillDefinition = (
  skillId: string,
  definitions: readonly SkillDefinition[] = SKILL_CATALOG,
): SkillDefinition | undefined => definitions.find((definition) => definition.skillId === skillId);

export const validateSkillGraph = (
  definitions: readonly SkillDefinition[] = SKILL_CATALOG,
): SkillGraphValidation => {
  const errors: string[] = [];
  const definitionById = new Map<string, SkillDefinition>();
  for (const definition of definitions) {
    if (definitionById.has(definition.skillId)) errors.push(`Duplicate skill ID: ${definition.skillId}`);
    definitionById.set(definition.skillId, definition);
    if (definition.difficulty < 0 || definition.difficulty > 1) {
      errors.push(`Difficulty for ${definition.skillId} must be between 0 and 1.`);
    }
  }
  for (const definition of definitions) {
    for (const prerequisite of definition.prerequisites) {
      if (!definitionById.has(prerequisite)) {
        errors.push(`Unknown prerequisite ${prerequisite} on ${definition.skillId}.`);
      }
      if (prerequisite === definition.skillId) {
        errors.push(`Skill ${definition.skillId} cannot depend on itself.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (skillId: string, path: string[]): void => {
    if (visiting.has(skillId)) {
      errors.push(`Skill graph cycle: ${[...path, skillId].join(" -> ")}`);
      return;
    }
    if (visited.has(skillId)) return;
    visiting.add(skillId);
    const definition = definitionById.get(skillId);
    for (const prerequisite of definition?.prerequisites ?? []) {
      if (definitionById.has(prerequisite)) visit(prerequisite, [...path, skillId]);
    }
    visiting.delete(skillId);
    visited.add(skillId);
  };
  for (const skillId of definitionById.keys()) visit(skillId, []);
  return { valid: errors.length === 0, errors };
};

export const getPrerequisiteClosure = (
  skillId: string,
  definitions: readonly SkillDefinition[] = SKILL_CATALOG,
): string[] => {
  const definitionById = new Map(definitions.map((definition) => [definition.skillId, definition]));
  const result = new Set<string>();
  const visit = (currentId: string): void => {
    for (const prerequisite of definitionById.get(currentId)?.prerequisites ?? []) {
      if (!result.has(prerequisite)) {
        result.add(prerequisite);
        visit(prerequisite);
      }
    }
  };
  visit(skillId);
  return [...result];
};

export const getUnlockedSkillDefinitions = (
  states: Readonly<Record<string, SkillState | undefined>>,
  definitions: readonly SkillDefinition[] = SKILL_CATALOG,
  masteryThreshold = 0.6,
): SkillDefinition[] =>
  definitions.filter((definition) => {
    if ((states[definition.skillId]?.attemptCount ?? 0) > 0) return true;
    return definition.prerequisites.every(
      (prerequisite) => (states[prerequisite]?.mastery ?? 0) >= masteryThreshold,
    );
  });
