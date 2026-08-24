> Status: this is the product/design brief, including deliberate future work. It
> is not an inventory of shipped behavior or a second implementation contract.
> `AGENTS.md` owns current engineering invariants, the source types own data
> schemas, and `README.md` lists verified shipped behavior.

You need to build one local-first auditory-motor music laboratory, not three disconnected quiz apps.

Call it NoteForge for now.

Its central job is to bind together four representations that you already possess in partially disconnected forms:

\text{heard sound}
\leftrightarrow
\text{vocal mechanics}
\leftrightarrow
\text{musical label}
\leftrightarrow
\text{harmonic function}

You can already hear and reproduce complicated vocal behavior, manipulate your vocal tract, imitate performers, write music, mix audio, and play instruments. Your gap is primarily the explicit mapping:

“That sound is E4.”
“That movement is a major third.”
“I’m singing the fifth of this chord.”
“I landed 23 cents flat.”
“That note feels tense because it is the minor second above the root.”

The project should make those mappings automatic.

1. The complete skill graph

Do not structure it as “Lesson 1, Lesson 2, Lesson 3.” Structure it as a graph of trainable primitives.

Perception

The ear-training side should progress through:

1. Same pitch versus different pitch
2. Higher versus lower
3. Approximate distance between pitches
4. Octave equivalence
5. Relative interval recognition
6. Pitch-class recognition
7. Specific note-and-octave recognition
8. Tonal-center recognition
9. Scale-degree recognition
10. Chord-tone recognition
11. Chord quality and inversion
12. Harmonic function
13. Melody and contour recognition
14. Intentional tension and resolution

Production

The vocal side should train:

1. Sliding into a target
2. Starting directly on a target
3. Holding the target
4. Holding it at different volumes
5. Moving between two notes
6. Reproducing an interval
7. Reproducing a scale degree against a tonic
8. Singing chord tones
9. Reproducing short melodies
10. Singing a harmony rather than copying the melody
11. Improvising within a harmonic context
12. Producing bends and intentional pitches between piano notes

Symbolic and spatial mapping

You also want to connect the same note to:

* its name;
* its octave;
* its frequency;
* its piano-key position;
* its guitar or bass position;
* its position within a scale;
* its position within a chord;
* its relationship to the preceding note.

The same sound should eventually become one navigable object rather than several unrelated facts.

2. The main application modes

A. Sound Laboratory

This is the free-experimentation screen, and it should be the foundation of the entire project.

Give yourself:

* A playable keyboard
* A chromatic note wheel
* A continuous frequency slider
* A cents-detuning control
* One-note drone mode
* Two-note dyad mode
* Chord builder
* Timbre selector
* Octave selector
* Sequential versus simultaneous playback
* Labels-hidden mode
* “Reveal relationship” button

You should be able to place C3 and C♯3 beside each other, hear the ugly rub, move C♯ upward one cent at a time, and watch the relationship transform.

Do not display notes as simply compatible or incompatible. That would teach the wrong model.

Display:

* interval;
* semitone distance;
* cent distance;
* pitch classes;
* chord membership;
* scale membership;
* tension relative to the active chord;
* possible resolutions.

The app should say:

D over C major: ninth, non-chord tone, diatonic tension.

Not:

D is wrong.

That distinction matters enormously for blues, jazz, grunge, and basically any music that does anything interesting.

Include a microtonal mode eventually. Your voice is continuous; it is not a piano. A blue third, bend, scoop, or deliberately unstable pitch should not be prematurely rounded into the nearest equal-tempered note.

B. Pitch Mirror

The app plays a target note and listens while you reproduce it.

There should be several variants:

Glide mode

The note sounds continuously while you slide toward it.

This teaches the physical location of the pitch.

Delayed match

The note plays, stops, and then you reproduce it.

This tests short-term auditory memory.

Cold attack

The target is shown by name or heard once, and you must begin directly on it without sliding.

This tests motor prediction.

Memory anchor

You hear A4, C4, or another selected reference at the beginning of the session. Later, the app asks you to reproduce it from memory.

Silent preparation

You hear the note, silently configure your vocal tract and internally simulate it, then press a button and phonate.

That mode is unusually suited to how you already operate.

The real-time visualization should look like a horizontal target lane:

+50 cents  ───────────────────────────
+25 cents  ───────────────────────────
Target     ═══════════════════════════
-25 cents  ───────────────────────────
-50 cents  ───────────────────────────
             your pitch contour →

Do not merely show a jumping tuner needle. Preserve the time history so you can see:

* initial attack;
* correction;
* drift;
* vibrato;
* instability;
* final release.

C. Pitch Hold and Dynamic Control

This isolates pitch from volume.

The app asks you to hold A3 while following a volume envelope:

quiet → medium → loud → medium → quiet

It scores pitch and loudness separately.

You want to prove that you can modify amplitude without unintentionally moving the fundamental frequency.

Variants should include:

* fixed pitch, free volume;
* fixed volume, fixed pitch;
* crescendo;
* decrescendo;
* pulses;
* long sustain;
* different vowels;
* hum versus open vowel;
* optional stylistic tone.

This is where your existing breath and volume control become directly attached to clean pitch.

D. Note Recognition

Keep absolute-label recognition separate from relative-pitch training.

Reference-backed mode

The app gives you a known anchor such as A4, then plays another note. You identify the second note.

This trains musical navigation.

No-reference mode

The app plays a note without an anchor, and you identify:

1. pitch class only, such as F♯;
2. octave only;
3. complete note, such as F♯3.

Score those independently. Calling F♯3 “F♯4” means your pitch-class memory succeeded while octave identification failed. That is different from answering C.

Cross-timbre mode

The same pitch should be rendered through:

* sine;
* triangle;
* piano;
* guitar;
* bass;
* flute-like tone;
* voice-like sample;
* harmonic-rich synth.

Otherwise, you risk memorizing incidental timbral clues rather than the note.

Octave-family mode

Play A2, A3, A4, and A5 and ask what they have in common.

This teaches pitch class independently of register.

E. Interval Laboratory

Intervals need four separate exercise types.

Recognition

Play two notes and identify their relationship.

Train:

* melodic ascending;
* melodic descending;
* harmonic simultaneous.

Production

Play a starting note and ask you to sing:

* minor third above;
* perfect fifth below;
* octave above;
* and so forth.

Comparison

Play two candidate intervals and ask which is wider, more consonant, or identical after transposition.

Mutation

Play a phrase and ask you to reproduce it:

* unchanged;
* one octave higher;
* a third above;
* transposed to a new starting note.

This is where your imitation ability turns into deliberate control.

The interface should initially allow sound-first mode:

Hear it. Reproduce it. Decide how it feels. Reveal the name afterward.

That matches how you naturally learn: phenomenon first, terminology second.

3. Tonal-center and scale-degree training

This is more useful for singing over real music than merely naming isolated notes.

The app establishes a tonic through a scale, drone, or short cadence. It then plays one note and asks:

Where is this relative to home?

Answers:

* 1 / tonic
* ♭2
* 2
* ♭3
* 3
* 4
* ♯4 / ♭5
* 5
* ♭6
* 6
* ♭7
* 7

Then invert the exercise:

The tonic is C. Sing the sixth.

Or:

Here is the chord. Sing its third.

Or:

Sing a note that creates tension, then resolve it to the nearest stable tone.

This is the stage at which “I can hear where the vocal should go” gets attached to actual harmonic knowledge.

Include these modes:

* major scale;
* natural minor;
* minor pentatonic;
* major pentatonic;
* blues scale;
* modal sets later;
* chromatic notes against a stable tonic.

Do not begin by dumping every scale into the app. Major, minor, pentatonic, and blues will give you an enormous amount of useful territory.

4. Chord and harmony laboratory

This is probably where the project becomes genuinely fun for you.

The app plays a chord and asks you to:

* identify the root;
* identify major/minor/diminished/augmented/suspended;
* sing the root;
* sing the third;
* sing the fifth;
* sing the seventh;
* select a tension;
* resolve that tension;
* choose a note shared with the next chord;
* choose the closest available chord tone after a chord change.

For example:

Chord: C major — C E G
Sing:
1. Root      → C
2. Third     → E
3. Fifth     → G
4. Ninth     → D
5. Minor 2nd → C♯, then resolve it

Then give yourself a progression:

C → Am → F → G

Ask the app for different missions:

* Stay on one shared note as long as possible.
* Sing roots only.
* Sing thirds only.
* Move to the nearest chord tone.
* Create a second vocal line.
* Deliberately create tension on beat three and resolve on beat one.
* Improvise using only chord tones.
* Improvise with diatonic passing tones.
* Add chromatic approach notes.

That teaches voice leading, not merely isolated note correctness.

Harmony-following mode

The app generates or accepts a simple melody and asks you to sing:

* unison;
* octave;
* fixed third above;
* chord-tone harmony;
* contrary motion;
* free harmony constrained to the current chord.

A fixed third is not always harmonically correct as chords change, which is exactly why this mode becomes educational. You’ll hear where blindly preserving an interval fails and chord-aware harmony succeeds.

5. Melody and phrase training

Call and response

The app generates a phrase, and you reproduce it.

Difficulty variables:

* note count;
* interval size;
* rhythm;
* octave range;
* key membership;
* chromaticism;
* playback count;
* response delay;
* starting note supplied or hidden.

Start with two or three notes. Eventually use eight-note phrases.

Contour mode

Before exact notes, identify or reproduce only the contour:

same → up → up → down → large drop

This isolates the shape from the labels.

Pitch drawing

Let yourself draw a pitch contour with the mouse or finger:

____/‾‾‾\____/‾

The app synthesizes it, then asks you to reproduce it.

That is extremely compatible with your visual and manifestation-oriented way of working. You’re effectively drawing a vocal gesture, hearing it, and then embodying it.

Voice-controlled spatial drawing

The inverse interaction is a Voice Arcade instrument: a continuously detected
pitch moves a drawing cursor while silence stops it. The first absolute control
bank maps eight neighboring chromatic notes clockwise to up, the four
diagonals, and the other cardinal directions. Free Draw creates without a
score; Trace exposes and scores a target route; Puzzle names an object but does
not pretend that path geometry can recognize a free-form picture.

Advanced variants may make intervals rotate a turtle-style heading rather than
mapping notes to absolute directions. Pitch stability, level, or independently
proved timbre dimensions may eventually affect line texture, width, or opacity,
but those dimensions must not be inferred from F0 or shipped without their own
signal proof.

Phrase transcription

The app plays a short phrase and lets you place notes on a piano roll. Then you sing what you transcribed.

This binds:

\text{hearing}
\to
\text{symbolic representation}
\to
\text{motor reproduction}

6. Song Laboratory

This is the final integration point, but it should not be the first thing you build.

Let yourself load a local audio file and:

* create loop regions;
* slow playback;
* transpose playback;
* mark breath points;
* mark phrase boundaries;
* enter the known key;
* enter or tap through chord changes;
* record your voice against the loop;
* display your pitch contour;
* compare multiple attempts;
* annotate intended notes or scale degrees.

Use headphones so the microphone does not re-capture the backing track when you request minimally processed audio input.

The first version should not attempt full automatic song transcription, source separation, chord detection, and vocal isolation. That is how a clean note trainer mutates into a five-year music-information-retrieval project wearing a fake mustache.

Start with:

1. manual loop;
2. manual key;
3. manually entered chord progression;
4. microphone pitch tracking;
5. recording comparison.

Later, when you have an isolated vocal stem or reference recording, add phrase-contour comparison.

Three ways to practice each phrase

For every selected song phrase:

1. Shadow: reproduce the original exactly.
2. Understand: identify its notes, intervals, and harmonic functions.
3. Mutate: sing another valid line over the same chords.

That turns your natural imitation into actual musical vocabulary.

7. The scoring system

Do not reduce attempts to a green check or red X.

For a single sustained note, calculate:

Metric	Meaning
Attack error	How far the initial voiced pitch was from the target
Median error	Central pitch offset in cents
Mean absolute error	Average distance from target
In-band time	Percentage of frames within the tolerance
Stability	Variation around the attempt’s median pitch
Drift	Whether pitch rises or falls over time
Hold duration	How long usable phonation continued
Onset latency	Time from prompt to phonation
Confidence	Reliability of pitch detection
Volume envelope	Loudness movement over time

Suggested adjustable tolerances:

* Beginner: ±35 cents
* Developing: ±20 cents
* Precise: ±10 cents

Those should be training settings, not moral judgments issued by the Ministry of Singing.

For natural vibrato, score the center independently from the oscillation. Estimate:

* vibrato center;
* depth in cents;
* rate;
* regularity.

Do not punish a centered vibrato merely because instantaneous pitch moves around.

For intervals, score the distance between your two produced notes:

\Delta_\text{actual} =
1200\log_2\left(\frac{f_2}{f_1}\right)

Then compare that with the target interval in cents. This allows you to sing both notes slightly sharp while still reproducing the interval accurately.

For phrases, compare:

* note sequence;
* contour;
* pitch-center error;
* interval error;
* rhythm;
* phrase timing.

Dynamic time warping is useful later for comparing two contours that were performed at slightly different speeds.

8. The adaptive training engine

Every exercise should update a skill graph rather than a single global score.

Example skill IDs:

pitch.direction
pitch.same_different
pitch.match.glide
pitch.match.cold_attack
pitch.hold.stability
pitch.absolute.pitch_class.C
pitch.absolute.octave
interval.recognize.m3.ascending
interval.produce.P5.descending
scale_degree.recognize.major.3
scale_degree.produce.minor.b7
chord_tone.produce.major.third
harmony.follow.chord_tones
melody.echo.length.4

Track for each skill:

* attempts;
* recent accuracy;
* long-term accuracy;
* response time;
* confidence;
* common confusions;
* last practiced;
* difficulty;
* next due date.

A session generator can use roughly:

* 60% weak or due skills;
* 20% recently acquired skills;
* 20% unfamiliar or exploratory material.

Also randomize:

* key;
* octave;
* timbre;
* ascending/descending;
* note duration;
* volume;
* starting pitch.

Otherwise, you can accidentally learn that the loud piano sample means C♯ and the quiet sine wave means G. Brains are clever little cheaters.

9. The audio architecture

The browser is completely capable of the core application. Web Audio provides scheduled synthesis, audio routing, live media-stream processing, oscillators, analysis, and low-latency musical playback; microphone capture comes through the Media Capture APIs. 

Use this pipeline:

                    ┌──────────────────────┐
Tone / Chord Engine ─► Web Audio Output    ├──► headphones
                    └──────────────────────┘
microphone
   │
   ▼
getUserMedia
   │
   ▼
AudioWorklet PCM window
   │
   ▼
stateless pitch detector ─────► shared live frame ─────► rendered note
   │                                  │
   └──► voicing/confidence result     └──► feature-local scorer
                                                │
                                                ▼
                                         exercise state

AudioWorklet level window ─────► diagnostic meter (never pitch admission)

Request microphone constraints approximately like:

{
  audio: {
    channelCount: 1,
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false }
  }
}

Then inspect the actual track settings; browser/device constraints are negotiated rather than magical commands to the hardware. 

Pitch detection

Start with YIN.

YIN was designed to estimate the fundamental frequency of speech and musical sound, and its original paper specifically describes it as relatively simple, efficient, low-latency, and requiring few tuned parameters. That makes it an excellent deterministic baseline for clean monophonic voice. 

Implementation strategy:

* mono samples;
* configurable minimum and maximum frequency;
* sample-rate-scaled power-of-two analysis windows that preserve the canonical
  capture duration and contain enough samples for the 45 Hz lower boundary;
* regular hop size;
* parabolic interpolation;
* confidence/periodicity threshold;
* one direct result for every live PCM window;
* optional post-hoc smoothing for recorded contours and aggregate scoring only.

Live note display must not wait for smoothing, multi-frame agreement, calibration,
an amplitude gate, or a lesson/scoring phase. Once microphone input is enabled,
every worklet pitch window is analyzed across the canonical 45–1,200 Hz range
until explicit Stop or stream failure. Prompts and navigation do not pause,
mute, clear, or replace that result.

Use a capture window long enough for the 45 Hz lower boundary at every supported
sample rate. The production capture-size function and detector proof must verify
every enclosed semitone and both literal boundaries.

Conceptually, detected frequency maps to a continuous MIDI coordinate:

m = 69 + 12\log_2\left(\frac{f}{440}\right)

with the inverse:

f = 440 \cdot 2^{(m-69)/12}

Production code must use `frequencyToMidi`, `splitMidiPitch`, and
`midiToFrequency` from `music-core` for those coordinates. Do not repeat the
rounding, signed-zero, pitch-class, octave, or numeric-boundary formulas in a
feature or detector package.

Do not snap the raw signal to a note before scoring. Preserve the continuous value.

Do not run a second live detector beside the canonical detector. Any future
replacement, neural or otherwise, must replace the production route in place
and pass the same full-range browser acceptance contract before it becomes
authoritative.

10. Recommended project architecture

Keep musical work local-first. The shipped Go boundary exists only to serve the
built application, expose health, and accept bounded same-origin derived
diagnostics. It must not become an account, synchronization, raw-audio, device
identity, or general telemetry backend.

The maintained ownership map is intentionally short so this document cannot
invent files that do not exist:

```text
apps/web                  React UI, Web Audio ownership, IndexedDB, diagnostics client
apps/web/public/worklets  production real-time capture processor
cmd/noteforge-server      static/SPA serving, health, bounded diagnostic validation
packages/music-core       canonical browser-independent pitch and harmony meaning
packages/pitch-engine     canonical detector frame and stateless YIN implementation
packages/trainer-core     audio-agnostic scoring, skill graph, progression, scheduling
tests                     cross-package and feature model tests
scripts                   build stamping and real-Chromium microphone proof
```

Use TypeScript, React, Web Audio, AudioWorklet, IndexedDB, service-worker
caching, and the bounded Go server according to those ownership boundaries.
Add a worker or WASM only after profiling demonstrates a concrete need. The
music theory package remains browser-independent; the pitch detector accepts
sample arrays; the trainer consumes canonical observations without owning
capture.

11. Core data structures

Do not copy schema declarations into prose. The canonical structures are:

* detector frames and reasons in `packages/pitch-engine/src/types.ts`;
* harmonic context in `packages/music-core/src/harmonic.ts`;
* targets, attempts, metrics, and skill state in
  `packages/trainer-core/src/types.ts`; and
* bounded diagnostic transport fields in
  `apps/web/src/diagnostics/pitch-diagnostics.ts` and the matching Go request
  types.

Package boundaries import or re-export those definitions instead of
redeclaring structurally similar copies.

Store raw recordings only when you explicitly enable them. The normal trainer can retain pitch contours and metrics without collecting a warehouse full of you singing “oooooo.”

12. The build sequence

Milestone 0 — Prove the measurement

Before making a pretty interface:

* Generate synthetic sine waves for every note.
* Generate ±10, ±25, and ±50-cent detuned versions.
* Add vibrato.
* Add amplitude changes.
* Add harmonics.
* Add modest noise.
* Run all of them through your pitch detector.
* Record octave-error rates.
* Validate the note/frequency conversions.

Acceptance criterion:

The detector can correctly track controlled synthetic targets across your intended vocal range, and failures are observable rather than silently rounded away.

Milestone 1 — First actually useful trainer

Build:

* tone generator;
* microphone input;
* pitch ribbon;
* target note;
* cents display;
* glide match;
* cold attack;
* pitch hold;
* local attempt history.

Use it immediately. Do not wait for the rest of the grand cathedral.

Milestone 2 — Ear recognition

Add:

* same/different;
* higher/lower;
* pitch-class identification;
* octave identification;
* anchor-backed note identification;
* no-anchor identification;
* cross-timbre tests;
* adaptive scheduling.

Milestone 3 — Intervals

Add:

* interval recognition;
* interval reproduction;
* melodic and harmonic intervals;
* transposition;
* confusion tracking;
* short call-and-response phrases.

Milestone 4 — Harmonic context

Add:

* tonic establishment;
* scale-degree recognition;
* scale-degree singing;
* chord builder;
* chord-tone singing;
* tension and resolution;
* voice-leading exercises.

This is the point where the app stops being a tuner and becomes a music trainer.

Milestone 5 — Melody and harmony

Add:

* generated melodies;
* phrase transcription;
* pitch-contour drawing;
* unison copying;
* fixed-interval harmony;
* chord-aware harmony;
* melody mutation.

Milestone 6 — Song Laboratory

Add:

* local audio loading;
* looping;
* slowing and transposition;
* manual key and chord annotation;
* voice recording;
* attempt comparison;
* phrase notebook.

Milestone 7 — Creative mode

Add:

* backing-progressions generator;
* real-time chord-tone display;
* improvisation capture;
* pitch-contour-to-MIDI conversion;
* melody editing;
* harmony generation;
* audio/MIDI export.

At that point NoteForge becomes a bridge from training into writing music.

13. The interface philosophy

For you specifically, every major trainer should have two presentations.

Discovery mode

* Hide labels.
* Play the phenomenon.
* Let you imitate or manipulate it.
* Ask what changed.
* Reveal terminology afterward.

Explicit mode

* Show note names.
* Show intervals.
* Show harmonic function.
* Show cents.
* Show exact scoring.

That prevents theory from replacing your ear while still connecting your ear to theory.

You also need an expert/debug view with:

* raw frequency;
* MIDI float;
* confidence;
* RMS;
* analysis window;
* raw and smoothed contours;
* detected octave jumps;
* microphone settings.

You are going to distrust the instrument if it tells you that you missed while your ear says otherwise. Give yourself enough evidence to interrogate the detector rather than blindly obey it.

14. What not to build

Do not begin with:

* accounts;
* cloud storage;
* leaderboards;
* streaks;
* social sharing;
* AI vocal coaching;
* automatic full-song transcription;
* automatic source separation;
* a complete DAW;
* a giant course full of canned explanations;
* a cartoon mascot celebrating because you identified B♭.

The essential loop is:

\text{hear}
\to
\text{predict}
\to
\text{produce or select}
\to
\text{measure}
\to
\text{understand}
\to
\text{repeat}

Everything else is optional furniture.

15. Your practical daily session

Once Milestone 4 exists, a strong twenty-minute session would be:

Time	Work
4 min	Random note matching and cold attacks
4 min	Holding pitch while changing volume or vowel
4 min	Interval recognition and reproduction
4 min	Singing chord roots, thirds, fifths, and tensions
4 min	One loop from a real song: copy, analyze, then mutate

That is enough to repeatedly reconnect your ear, internal simulation, vocal mechanics, and formal note system.

The final objective is not merely:

“I can name a beep.”

It is:

I hear a musical possibility, understand its relationship to the surrounding sound, know approximately how my body must produce it, and can deliberately choose whether to reinforce, harmonize, destabilize, or resolve it.

That would take all the vocal and musical machinery you already developed and finally give it a shared coordinate system.
