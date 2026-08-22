import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeHarmonicRelationship } from "@noteforge/music-core";
import { Drone, playFrequencies, playTone, TIMBRES } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import {
  CHORD_PRESETS, continuousMidiToHz, INTERVAL_LONG, INTERVAL_SHORT, nearestResolutionPitchClasses,
  noteLabel, pitchClassLabel, SCALE_PRESETS, signed
} from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

type LabMode = "note" | "dyad" | "chord";

const whitePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
const whiteNotes = Array.from({ length: 22 }, (_, index) => 48 + index).filter((midi) => whitePitchClasses.has(midi % 12));
const blackNotes = Array.from({ length: 22 }, (_, index) => 48 + index).filter((midi) => !whitePitchClasses.has(midi % 12));

function whitePositionForBlack(midi: number): number {
  const precedingWhites = whiteNotes.filter((note) => note < midi).length;
  return (precedingWhites / whiteNotes.length) * 100;
}

function Keyboard({ selectedMidi, compareMidi, onSelect }: { selectedMidi: number; compareMidi: number; onSelect: (midi: number) => void }) {
  return (
    <div className="keyboard" role="group" aria-label="Playable keyboard from C3 to A4">
      <div className="white-keys">
        {whiteNotes.map((midi) => (
          <button key={midi} className={`${selectedMidi === midi ? "selected" : ""} ${compareMidi === midi ? "compare" : ""}`} onPointerDown={() => onSelect(midi)} aria-label={noteLabel(midi)}>
            {midi % 12 === 0 && <span>{noteLabel(midi)}</span>}
          </button>
        ))}
      </div>
      {blackNotes.map((midi) => (
        <button key={midi} className={`black-key ${selectedMidi === midi ? "selected" : ""} ${compareMidi === midi ? "compare" : ""}`} style={{ left: `calc(${whitePositionForBlack(midi)}% - 1.55%)` }} onPointerDown={() => onSelect(midi)} aria-label={noteLabel(midi)} />
      ))}
    </div>
  );
}

function NoteWheel({ tonic, selected, scalePcs, chordPcs, onSelect }: { tonic: number; selected: number; scalePcs: number[]; chordPcs: number[]; onSelect: (pc: number) => void }) {
  return (
    <div className="note-wheel" aria-label="Chromatic note wheel">
      <div className="wheel-rings" />
      {Array.from({ length: 12 }, (_, pc) => {
        const angle = pc * 30 - 90;
        const radius = 43;
        const x = 50 + radius * Math.cos(angle * Math.PI / 180);
        const y = 50 + radius * Math.sin(angle * Math.PI / 180);
        const classes = [pc === selected % 12 ? "selected" : "", pc === tonic ? "tonic" : "", chordPcs.includes(pc) ? "chord" : "", scalePcs.includes(pc) ? "scale" : ""].filter(Boolean).join(" ");
        return <button key={pc} className={classes} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onSelect(pc)}><span>{pitchClassLabel(pc)}</span></button>;
      })}
      <div className="wheel-center"><small>TONIC</small><strong>{pitchClassLabel(tonic)}</strong><span>{SCALE_PRESETS.major.intervals.length} tones</span></div>
    </div>
  );
}

function FrequencyReadout({ midi, cents, onChange }: { midi: number; cents: number; onChange: (midi: number, cents: number) => void }) {
  const frequency = continuousMidiToHz(midi, cents);
  const sliderValue = 12 * Math.log2(frequency / 65.406) * 100;
  const changeFrequency = (nextValue: number) => {
    const hz = 65.406 * 2 ** (nextValue / 1200);
    const continuousMidi = 69 + 12 * Math.log2(hz / 440);
    const nearest = Math.round(continuousMidi);
    onChange(nearest, Math.round((continuousMidi - nearest) * 100));
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
  const [droneOn, setDroneOn] = useState(false);
  const drone = useRef(new Drone());

  useEffect(() => () => drone.current.stop(), []);

  const scale = SCALE_PRESETS[scaleId] ?? SCALE_PRESETS.major;
  const chord = CHORD_PRESETS[chordQuality] ?? CHORD_PRESETS.major;
  const scalePcs = scale.intervals.map((interval) => (tonicPitchClass + interval) % 12);
  const chordPcs = chord.intervals.map((interval) => (tonicPitchClass + interval) % 12);
  const firstFrequency = continuousMidiToHz(selectedMidi, centsOffset);
  const secondFrequency = continuousMidiToHz(compareMidi, compareCents);

  const relationship = useMemo(() => {
    const totalCents = (compareMidi - selectedMidi) * 100 + compareCents - centsOffset;
    const semitones = Math.round(Math.abs(totalCents) / 100);
    const simple = semitones % 12;
    const intervalIndex = semitones === 12 ? 12 : simple;
    const comparePc = ((compareMidi % 12) + 12) % 12;
    const isChordTone = chordPcs.includes(comparePc);
    const isScaleTone = scalePcs.includes(comparePc);
    const resolutions = nearestResolutionPitchClasses(comparePc, chordPcs);
    const functionLabel = isChordTone ? "chord tone · stable color" : isScaleTone ? "non-chord tone · diatonic tension" : "chromatic color · active tension";
    const chordDegree = chord.intervals.indexOf((comparePc - tonicPitchClass + 12) % 12);
    const chordNames = ["root", "third", "fifth", "seventh"];
    const qualityMap: Record<string, string> = { sus2: "suspended-2", sus4: "suspended-4", major7: "major-7", dominant7: "dominant-7", minor7: "minor-7" };
    const theory = analyzeHarmonicRelationship(
      { pitchClass: comparePc, centsOffset: compareCents },
      {
        tonicPitchClass,
        scalePitchClasses: scalePcs,
        chordPitchClasses: chordPcs,
        chordRoot: tonicPitchClass,
        chordQuality: qualityMap[chordQuality] ?? chordQuality,
        scaleName: `${pitchClassLabel(tonicPitchClass)} ${scale.label}`,
        chordName: `${pitchClassLabel(tonicPitchClass)} ${chord.label.toLowerCase()}`
      }
    );
    return { totalCents, semitones, intervalIndex, comparePc, isChordTone, isScaleTone, resolutions, functionLabel, chordRole: chordDegree >= 0 ? chordNames[chordDegree] ?? `chord tone ${chordDegree + 1}` : null, theory };
  }, [compareMidi, selectedMidi, compareCents, centsOffset, chordPcs.join(), scalePcs.join(), tonicPitchClass, chord.intervals.join(), chordQuality, chord.label, scale.label]);

  const selectPitchClass = (pitchClass: number) => {
    const current = editSlot === "first" ? selectedMidi : compareMidi;
    let next = current - ((current % 12 + 12) % 12) + pitchClass;
    if (next - current > 6) next -= 12;
    if (current - next > 6) next += 12;
    if (editSlot === "first") { setSelectedMidi(next); setCentsOffset(0); }
    else { setCompareMidi(next); setCompareCents(0); }
    void playTone({ frequencyHz: continuousMidiToHz(next), timbre, duration: 0.75 });
  };

  const selectKeyboardNote = (midi: number) => {
    if (editSlot === "first") { setSelectedMidi(midi); setCentsOffset(0); }
    else { setCompareMidi(midi); setCompareCents(0); }
    void playTone({ frequencyHz: continuousMidiToHz(midi), timbre, duration: 0.8 });
  };

  const playCurrent = () => {
    const frequencies = mode === "note" ? [firstFrequency] : mode === "dyad" ? [firstFrequency, secondFrequency] : chord.intervals.map((interval) => continuousMidiToHz(60 + tonicPitchClass + interval));
    void playFrequencies(frequencies, mode === "chord" ? "simultaneous" : playbackMode, { timbre, duration: 1.15 });
  };

  const toggleDrone = async () => {
    if (droneOn) drone.current.stop();
    else await drone.current.start(continuousMidiToHz(48 + tonicPitchClass), timbre);
    setDroneOn(!droneOn);
  };

  return (
    <div className="page sound-lab-page">
      <div className="lab-intro">
        <div><Eyebrow>Phenomenon before verdict</Eyebrow><h1>Place sound in context.</h1><p>Manipulate pitch continuously, then reveal what the relationship is doing—never whether it is “allowed.”</p></div>
        <div className="intro-actions"><Switch label="Hide labels" checked={labelsHidden} onChange={setLabelsHidden} /><ActionButton className={droneOn ? "active coral" : ""} onClick={toggleDrone}><span className="status-dot" /> {droneOn ? "Stop drone" : "Tonic drone"}</ActionButton></div>
      </div>

      <div className="sound-workbench">
        <Panel className="sound-instrument">
          <div className="instrument-top">
            <Segmented label="Voice configuration" value={mode} onChange={setMode} options={[{ value: "note", label: "One note" }, { value: "dyad", label: "Two-note dyad" }, { value: "chord", label: "Chord" }]} />
            <Segmented label="Playback" value={playbackMode} onChange={setPlaybackMode} options={[{ value: "sequential", label: "Sequential" }, { value: "simultaneous", label: "Together" }]} />
            <Select label="Timbre" value={timbre} onChange={(event) => setTimbre(event.target.value as typeof timbre)}>{TIMBRES.map((item) => <option key={item}>{item}</option>)}</Select>
          </div>

          <div className="pitch-slots">
            <button className={`pitch-slot first ${editSlot === "first" ? "active" : ""}`} onClick={() => setEditSlot("first")}>
              <span>A · REFERENCE</span><strong>{labelsHidden ? "?" : noteLabel(selectedMidi)}</strong><small>{labelsHidden ? "labels hidden" : `${firstFrequency.toFixed(2)} Hz`}</small>
              <i style={{ transform: `translateX(${Math.max(-48, Math.min(48, centsOffset))}%)` }} />
            </button>
            <div className="relationship-mark"><span>{playbackMode === "simultaneous" ? "+" : "→"}</span><small>{mode === "dyad" ? `${Math.abs(relationship.totalCents).toFixed(0)}¢` : ""}</small></div>
            <button disabled={mode === "note"} className={`pitch-slot second ${editSlot === "second" ? "active" : ""}`} onClick={() => setEditSlot("second")}>
              <span>B · COLOR</span><strong>{labelsHidden ? "?" : noteLabel(compareMidi)}</strong><small>{labelsHidden ? "labels hidden" : `${secondFrequency.toFixed(2)} Hz`}</small>
              <i style={{ transform: `translateX(${Math.max(-48, Math.min(48, compareCents))}%)` }} />
            </button>
            <PlayButton label={mode === "chord" ? `Play ${pitchClassLabel(tonicPitchClass)} ${chord.label}` : mode === "dyad" ? "Hear relationship" : "Play note"} onClick={playCurrent} />
          </div>

          <Keyboard selectedMidi={selectedMidi} compareMidi={compareMidi} onSelect={selectKeyboardNote} />

          <div className="continuous-section">
            <div className="continuous-heading"><div><Eyebrow>Edit {editSlot === "first" ? "reference A" : "color B"}</Eyebrow><h3>Between the keys</h3></div><div className="cents-readout"><button onClick={() => editSlot === "first" ? setCentsOffset(centsOffset - 1) : setCompareCents(compareCents - 1)}>−</button><strong>{signed(editSlot === "first" ? centsOffset : compareCents)}<small>¢</small></strong><button onClick={() => editSlot === "first" ? setCentsOffset(centsOffset + 1) : setCompareCents(compareCents + 1)}>+</button></div></div>
            <FrequencyReadout midi={editSlot === "first" ? selectedMidi : compareMidi} cents={editSlot === "first" ? centsOffset : compareCents} onChange={(midi, cents) => editSlot === "first" ? (setSelectedMidi(midi), setCentsOffset(cents)) : (setCompareMidi(midi), setCompareCents(cents))} />
            <input className="detune-slider" type="range" min="-50" max="50" step="1" value={editSlot === "first" ? centsOffset : compareCents} onChange={(event) => editSlot === "first" ? setCentsOffset(Number(event.target.value)) : setCompareCents(Number(event.target.value))} aria-label="Cents detuning" />
            <div className="detune-labels"><span>−50¢</span><span>EQUAL TEMPERED</span><span>+50¢</span></div>
          </div>
        </Panel>

        <div className="sound-side">
          <Panel className="wheel-panel">
            <div className="panel-heading"><div><Eyebrow>Same object · circular view</Eyebrow><h2>Chromatic wheel</h2></div><span className="legend-dots"><i className="tonic" /> tonic <i className="chord" /> chord <i className="scale" /> scale</span></div>
            <NoteWheel tonic={tonicPitchClass} selected={(editSlot === "first" ? selectedMidi : compareMidi) % 12} scalePcs={scalePcs} chordPcs={chordPcs} onSelect={selectPitchClass} />
          </Panel>

          <Panel className="context-panel">
            <div className="panel-heading"><div><Eyebrow>Harmonic lens</Eyebrow><h2>Active context</h2></div></div>
            <div className="context-controls">
              <Select label="Tonic" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>{Array.from({ length: 12 }, (_, pc) => <option key={pc} value={pc}>{pitchClassLabel(pc)}</option>)}</Select>
              <Select label="Scale" value={scaleId} onChange={(event) => setScaleId(event.target.value)}>{Object.entries(SCALE_PRESETS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</Select>
              <Select label="Chord" value={chordQuality} onChange={(event) => setChordQuality(event.target.value)}>{Object.entries(CHORD_PRESETS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</Select>
            </div>
            <div className="context-notes">{Array.from({ length: 12 }, (_, pc) => <span key={pc} className={`${chordPcs.includes(pc) ? "chord" : scalePcs.includes(pc) ? "scale" : ""}`}>{pitchClassLabel(pc)}</span>)}</div>
          </Panel>
        </div>
      </div>

      <Panel className={`relationship-panel ${relationshipRevealed ? "revealed" : "hidden"}`}>
        <button className="relationship-reveal" onClick={() => setRelationshipRevealed(!relationshipRevealed)}><Icon name={relationshipRevealed ? "eyeOff" : "eye"} size={18} /> {relationshipRevealed ? "Hide relationship" : "Reveal relationship"}</button>
        {relationshipRevealed ? (
          <div className="relationship-content">
            <div className="relationship-title"><Eyebrow>Relationship, not judgment</Eyebrow><h2>{pitchClassLabel(relationship.comparePc)} over {pitchClassLabel(tonicPitchClass)} {chord.label.toLowerCase()}</h2><p>{relationship.theory.interval.harmonicName}, {relationship.functionLabel}.</p></div>
            <dl>
              <div><dt>Interval from A</dt><dd>{INTERVAL_LONG[relationship.intervalIndex] ?? `${relationship.semitones} semitones`} <small>{INTERVAL_SHORT[relationship.intervalIndex] ?? ""}</small></dd></div>
              <div><dt>Distance</dt><dd>{relationship.semitones} semitones <small>{signed(relationship.totalCents)} cents</small></dd></div>
              <div><dt>Chord membership</dt><dd>{relationship.isChordTone ? `Yes · ${relationship.chordRole}` : "No · color tone"}</dd></div>
              <div><dt>Scale membership</dt><dd>{relationship.isScaleTone ? `Yes · ${scale.label}` : `Outside ${scale.label}`}</dd></div>
              <div><dt>Possible resolutions</dt><dd>{relationship.theory.possibleResolutions.map((item) => item.noteName).join(" or ") || "hold"} <small>{relationship.theory.possibleResolutions[0]?.description ?? "already centered on a chord tone"}</small></dd></div>
            </dl>
          </div>
        ) : <div className="discovery-prompt"><span className="wave-mark">∿</span><div><h3>Stay with the phenomenon.</h3><p>Hear it, imitate it, decide where it wants to move—then reveal the language.</p></div></div>}
      </Panel>
    </div>
  );
}
