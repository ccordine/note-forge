import { useEffect, useRef, useState } from "react";
import {
  analyzeHarmonicRelationship,
  buildChord,
  buildScale,
  createHarmonicContext,
  intervalBetweenMidi,
  normalizePitchClass,
  splitMidiPitch,
} from "@noteforge/music-core";
import { Drone, playFrequencies, playSafely, playTone, TIMBRES } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import {
  CHORD_PRESETS, continuousMidiToHz, isChordPresetId, isScalePresetId, noteLabel, pitchClassLabel, SCALE_PRESETS, signed
} from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { PianoKeyboard } from "@/ui/PianoKeyboard";

type LabMode = "note" | "dyad" | "chord";

function NoteWheel({ tonic, selected, scalePcs, chordPcs, onSelect }: { tonic: number; selected: number; scalePcs: readonly number[]; chordPcs: readonly number[]; onSelect: (pc: number) => void }) {
  return (
    <div className="note-wheel" aria-label="Chromatic note wheel">
      <div className="wheel-rings" />
      {Array.from({ length: 12 }, (_, pc) => {
        const angle = pc * 30 - 90;
        const radius = 43;
        const x = 50 + radius * Math.cos(angle * Math.PI / 180);
        const y = 50 + radius * Math.sin(angle * Math.PI / 180);
        const classes = [pc === normalizePitchClass(selected) ? "selected" : "", pc === tonic ? "tonic" : "", chordPcs.includes(pc) ? "chord" : "", scalePcs.includes(pc) ? "scale" : ""].filter(Boolean).join(" ");
        return <button key={pc} className={classes} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onSelect(pc)}><span>{pitchClassLabel(pc)}</span></button>;
      })}
      <div className="wheel-center"><small>TONIC</small><strong>{pitchClassLabel(tonic)}</strong><span>{SCALE_PRESETS.major.intervals.length} tones</span></div>
    </div>
  );
}

function FrequencyReadout({ midi, cents, onChange }: { midi: number; cents: number; onChange: (midi: number, cents: number) => void }) {
  const frequency = continuousMidiToHz(midi, cents);
  const sliderValue = (midi + cents / 100 - 36) * 100;
  const changeFrequency = (nextValue: number) => {
    const pitch = splitMidiPitch(36 + nextValue / 100);
    onChange(pitch.nearestMidi, pitch.centsFromNearest);
  };
  return (
    <div className="frequency-control">
      <div className="frequency-number"><strong>{frequency.toFixed(2)}</strong><span>Hz</span></div>
      <input aria-label="Continuous frequency" type="range" min="0" max="4800" step="1" value={sliderValue} onChange={(event) => changeFrequency(Number(event.target.value))} />
      <div className="frequency-scale"><span>65 Hz</span><span>CONTINUOUS FREQUENCY</span><span>1,047 Hz</span></div>
    </div>
  );
}

export function SoundLab() {
  const {
    selectedMidi, setSelectedMidi, centsOffset, setCentsOffset, compareMidi, setCompareMidi, compareCents,
    setCompareCents, tonicPitchClass, setTonicPitchClass, scaleId, setScaleId, chordQuality, setChordQuality,
    timbre, setTimbre, playbackMode, setPlaybackMode, labelsHidden, setLabelsHidden
  } = useLab();
  const [mode, setMode] = useState<LabMode>("dyad");
  const [editSlot, setEditSlot] = useState<"first" | "second">("first");
  const [relationshipRevealed, setRelationshipRevealed] = useState(true);
  const [droneEnabled, setDroneEnabled] = useState(false);
  const [droneState, setDroneState] = useState<"off" | "starting" | "on">("off");
  const [playbackError, setPlaybackError] = useState("");
  const drone = useRef(new Drone());

  const scalePreset = SCALE_PRESETS[scaleId] ?? SCALE_PRESETS.major;
  const chordPreset = CHORD_PRESETS[chordQuality] ?? CHORD_PRESETS.major;
  const scale = buildScale(tonicPitchClass, scalePreset.type);
  const chord = buildChord(tonicPitchClass, chordPreset.quality);
  const harmonicContext = createHarmonicContext(scale, chord);
  const scalePcs = scale.pitchClasses;
  const chordPcs = chord.pitchClasses;
  const firstPitch = splitMidiPitch(selectedMidi + centsOffset / 100);
  const secondPitch = splitMidiPitch(compareMidi + compareCents / 100);
  const firstFrequency = continuousMidiToHz(firstPitch.midiFloat);
  const secondFrequency = continuousMidiToHz(secondPitch.midiFloat);
  const dyadInterval = intervalBetweenMidi(firstPitch.midiFloat, secondPitch.midiFloat);
  const theory = analyzeHarmonicRelationship({ midi: secondPitch.midiFloat }, harmonicContext);
  const relationship = {
    totalCents: dyadInterval.exactCents,
    semitones: Math.abs(dyadInterval.nearestSemitones),
    interval: dyadInterval.interval,
    comparePc: theory.pitch.pitchClass,
    isChordTone: theory.chordMembership.member,
    isScaleTone: theory.scaleMembership.member,
    functionLabel: theory.tension.label,
    chordRole: theory.chordMembership.role,
    theory,
  };

  useEffect(() => {
    if (!droneEnabled) {
      drone.current.stop();
      setDroneState("off");
      return;
    }
    let active = true;
    setDroneState("starting");
    setPlaybackError("");
    drone.current.start(continuousMidiToHz(48 + tonicPitchClass), timbre)
      .then(() => {
        if (active) setDroneState("on");
      })
      .catch((error) => {
        if (!active) return;
        setDroneEnabled(false);
        setDroneState("off");
        setPlaybackError(error instanceof Error ? error.message : "The tonic drone could not start.");
      });
    return () => {
      active = false;
      drone.current.stop();
    };
  }, [droneEnabled, timbre, tonicPitchClass]);

  const setPitch = (slot: "first" | "second", midi: number, cents: number) => {
    const normalized = splitMidiPitch(midi + cents / 100);
    if (slot === "first") {
      setSelectedMidi(normalized.nearestMidi);
      setCentsOffset(normalized.centsFromNearest);
    } else {
      setCompareMidi(normalized.nearestMidi);
      setCompareCents(normalized.centsFromNearest);
    }
  };

  const selectPitchClass = (pitchClass: number) => {
    const current = editSlot === "first" ? firstPitch.nearestMidi : secondPitch.nearestMidi;
    let next = current - normalizePitchClass(current) + normalizePitchClass(pitchClass);
    if (next - current > 6) next -= 12;
    if (current - next > 6) next += 12;
    setPitch(editSlot, next, 0);
    playSafely(playTone({ frequencyHz: continuousMidiToHz(next), timbre, duration: 0.75 }), "Sound Lab pitch-class tone");
  };

  const selectKeyboardNote = (midi: number) => {
    setPitch(editSlot, midi, 0);
    playSafely(playTone({ frequencyHz: continuousMidiToHz(midi), timbre, duration: 0.8 }), "Sound Lab keyboard tone");
  };

  const playCurrent = () => {
    const frequencies = mode === "note" ? [firstFrequency] : mode === "dyad" ? [firstFrequency, secondFrequency] : chord.intervals.map((interval) => continuousMidiToHz(60 + tonicPitchClass + interval));
    playSafely(playFrequencies(frequencies, mode === "chord" ? "simultaneous" : playbackMode, { timbre, duration: 1.15 }), "Sound Lab playback");
  };

  return (
    <div className="page sound-lab-page">
      <div className="lab-intro">
        <div><Eyebrow>Phenomenon before verdict</Eyebrow><h1>Place sound in context.</h1><p>Manipulate pitch continuously, then reveal what the relationship is doing—never whether it is “allowed.”</p></div>
        <div className="intro-actions"><Switch label="Hide labels" checked={labelsHidden} onChange={setLabelsHidden} /><ActionButton className={droneEnabled ? "active coral" : ""} onClick={() => setDroneEnabled((enabled) => !enabled)}><span className="status-dot" /> {droneState === "starting" ? "Starting drone…" : droneEnabled ? "Stop drone" : "Tonic drone"}</ActionButton></div>
      </div>

      {playbackError && <div className="error-banner"><strong>Playback needs attention.</strong><span>{playbackError}</span></div>}

      <div className="sound-workbench">
        <Panel className="sound-instrument">
          <div className="instrument-top">
            <Segmented label="Voice configuration" value={mode} onChange={setMode} options={[{ value: "note", label: "One note" }, { value: "dyad", label: "Two-note dyad" }, { value: "chord", label: "Chord" }]} />
            <Segmented label="Playback" value={playbackMode} onChange={setPlaybackMode} options={[{ value: "sequential", label: "Sequential" }, { value: "simultaneous", label: "Together" }]} />
            <Select label="Timbre" value={timbre} onChange={(event) => setTimbre(event.target.value as typeof timbre)}>{TIMBRES.map((item) => <option key={item}>{item}</option>)}</Select>
          </div>

          <div className="pitch-slots">
            <button className={`pitch-slot first ${editSlot === "first" ? "active" : ""}`} onClick={() => setEditSlot("first")}>
              <span>A · REFERENCE</span><strong>{labelsHidden ? "?" : noteLabel(firstPitch.nearestMidi)}</strong><small>{labelsHidden ? "labels hidden" : `${firstFrequency.toFixed(2)} Hz`}</small>
              <i style={{ transform: `translateX(${Math.max(-48, Math.min(48, firstPitch.centsFromNearest))}%)` }} />
            </button>
            <div className="relationship-mark"><span>{playbackMode === "simultaneous" ? "+" : "→"}</span><small>{mode === "dyad" ? `${Math.abs(relationship.totalCents).toFixed(0)}¢` : ""}</small></div>
            <button disabled={mode === "note"} className={`pitch-slot second ${editSlot === "second" ? "active" : ""}`} onClick={() => setEditSlot("second")}>
              <span>B · COLOR</span><strong>{labelsHidden ? "?" : noteLabel(secondPitch.nearestMidi)}</strong><small>{labelsHidden ? "labels hidden" : `${secondFrequency.toFixed(2)} Hz`}</small>
              <i style={{ transform: `translateX(${Math.max(-48, Math.min(48, secondPitch.centsFromNearest))}%)` }} />
            </button>
            <PlayButton label={mode === "chord" ? `Play ${pitchClassLabel(tonicPitchClass)} ${chordPreset.label}` : mode === "dyad" ? "Hear relationship" : "Play note"} onClick={playCurrent} />
          </div>

          <PianoKeyboard
            className="sound-lab-keyboard"
            startMidi={48}
            endMidi={69}
            showLabels={!labelsHidden}
            markers={[
              { midi: firstPitch.nearestMidi, role: "selected", label: "reference A" },
              { midi: secondPitch.nearestMidi, role: "compare", label: "color B" },
            ]}
            onKeyPress={selectKeyboardNote}
            ariaLabel="Playable Sound Lab keyboard from C3 to A4"
          />

          <div className="continuous-section">
            <div className="continuous-heading"><div><Eyebrow>Edit {editSlot === "first" ? "reference A" : "color B"}</Eyebrow><h3>Between the keys</h3></div><div className="cents-readout"><button onClick={() => setPitch(editSlot, editSlot === "first" ? firstPitch.nearestMidi : secondPitch.nearestMidi, (editSlot === "first" ? firstPitch.centsFromNearest : secondPitch.centsFromNearest) - 1)}>−</button><strong>{signed(editSlot === "first" ? firstPitch.centsFromNearest : secondPitch.centsFromNearest)}<small>¢</small></strong><button onClick={() => setPitch(editSlot, editSlot === "first" ? firstPitch.nearestMidi : secondPitch.nearestMidi, (editSlot === "first" ? firstPitch.centsFromNearest : secondPitch.centsFromNearest) + 1)}>+</button></div></div>
            <FrequencyReadout midi={editSlot === "first" ? firstPitch.nearestMidi : secondPitch.nearestMidi} cents={editSlot === "first" ? firstPitch.centsFromNearest : secondPitch.centsFromNearest} onChange={(midi, cents) => setPitch(editSlot, midi, cents)} />
            <input className="detune-slider" type="range" min="-50" max="50" step="1" value={editSlot === "first" ? firstPitch.centsFromNearest : secondPitch.centsFromNearest} onChange={(event) => setPitch(editSlot, editSlot === "first" ? firstPitch.nearestMidi : secondPitch.nearestMidi, Number(event.target.value))} aria-label="Cents detuning" />
            <div className="detune-labels"><span>−50¢</span><span>EQUAL TEMPERED</span><span>+50¢</span></div>
          </div>
        </Panel>

        <div className="sound-side">
          <Panel className="wheel-panel">
            <div className="panel-heading"><div><Eyebrow>Same object · circular view</Eyebrow><h2>Chromatic wheel</h2></div><span className="legend-dots"><i className="tonic" /> tonic <i className="chord" /> chord <i className="scale" /> scale</span></div>
            <NoteWheel tonic={normalizePitchClass(tonicPitchClass)} selected={editSlot === "first" ? firstPitch.pitchClass : secondPitch.pitchClass} scalePcs={scalePcs} chordPcs={chordPcs} onSelect={selectPitchClass} />
          </Panel>

          <Panel className="context-panel">
            <div className="panel-heading"><div><Eyebrow>Harmonic lens</Eyebrow><h2>Active context</h2></div></div>
            <div className="context-controls">
              <Select label="Tonic" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>{Array.from({ length: 12 }, (_, pc) => <option key={pc} value={pc}>{pitchClassLabel(pc)}</option>)}</Select>
              <Select label="Scale" value={scaleId} onChange={(event) => { if (isScalePresetId(event.target.value)) setScaleId(event.target.value); }}>{Object.entries(SCALE_PRESETS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</Select>
              <Select label="Chord" value={chordQuality} onChange={(event) => { if (isChordPresetId(event.target.value)) setChordQuality(event.target.value); }}>{Object.entries(CHORD_PRESETS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</Select>
            </div>
            <div className="context-notes">{Array.from({ length: 12 }, (_, pc) => <span key={pc} className={`${chordPcs.includes(pc) ? "chord" : scalePcs.includes(pc) ? "scale" : ""}`}>{pitchClassLabel(pc)}</span>)}</div>
          </Panel>
        </div>
      </div>

      <Panel className={`relationship-panel ${relationshipRevealed ? "revealed" : "hidden"}`}>
        <button className="relationship-reveal" onClick={() => setRelationshipRevealed(!relationshipRevealed)}><Icon name={relationshipRevealed ? "eyeOff" : "eye"} size={18} /> {relationshipRevealed ? "Hide relationship" : "Reveal relationship"}</button>
        {relationshipRevealed ? (
          <div className="relationship-content">
            <div className="relationship-title"><Eyebrow>Relationship, not judgment</Eyebrow><h2>{pitchClassLabel(relationship.comparePc)} over {pitchClassLabel(tonicPitchClass)} {chordPreset.label.toLowerCase()}</h2><p>{relationship.theory.interval.harmonicName}, {relationship.functionLabel}.</p></div>
            <dl>
              <div><dt>Interval from A</dt><dd>{relationship.interval.name} <small>{relationship.interval.shortName}</small></dd></div>
              <div><dt>Distance</dt><dd>{relationship.semitones} semitones <small>{signed(relationship.totalCents)} cents</small></dd></div>
              <div><dt>Chord membership</dt><dd>{relationship.isChordTone ? `Yes · ${relationship.chordRole}` : "No · color tone"}</dd></div>
              <div><dt>Scale membership</dt><dd>{relationship.isScaleTone ? `Yes · ${scalePreset.label}` : `Outside ${scalePreset.label}`}</dd></div>
              <div><dt>Possible resolutions</dt><dd>{relationship.theory.possibleResolutions.map((item) => item.noteName).join(" or ") || "hold"} <small>{relationship.theory.possibleResolutions[0]?.description ?? "already centered on a chord tone"}</small></dd></div>
            </dl>
          </div>
        ) : <div className="discovery-prompt"><span className="wave-mark">∿</span><div><h3>Stay with the phenomenon.</h3><p>Hear it, imitate it, decide where it wants to move—then reveal the language.</p></div></div>}
      </Panel>
    </div>
  );
}
