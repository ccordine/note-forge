import { useEffect, useMemo, useRef, useState } from "react";
import { playFrequencies, playTone } from "@/audio/synth";
import { CHORD_PRESETS, continuousMidiToHz, nearestResolutionPitchClasses, noteLabel, pitchClassLabel, SCALE_PRESETS } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

type HarmonyView = "scaleDegree" | "chordTone" | "voiceLeading" | "harmonyFollow";
type MissionId = "roots" | "thirds" | "nearest" | "shared" | "tension" | "free";

interface ProgressionChord { degree: number; quality: keyof typeof CHORD_PRESETS; roman: string; }

const progressionPresets: Record<string, { label: string; chords: ProgressionChord[] }> = {
  pop: { label: "I · vi · IV · V", chords: [{ degree: 0, quality: "major", roman: "I" }, { degree: 9, quality: "minor", roman: "vi" }, { degree: 5, quality: "major", roman: "IV" }, { degree: 7, quality: "major", roman: "V" }] },
  minor: { label: "i · ♭VI · ♭III · ♭VII", chords: [{ degree: 0, quality: "minor", roman: "i" }, { degree: 8, quality: "major", roman: "♭VI" }, { degree: 3, quality: "major", roman: "♭III" }, { degree: 10, quality: "major", roman: "♭VII" }] },
  jazz: { label: "ii⁷ · V⁷ · Imaj⁷", chords: [{ degree: 2, quality: "minor7", roman: "ii⁷" }, { degree: 7, quality: "dominant7", roman: "V⁷" }, { degree: 0, quality: "major7", roman: "Imaj⁷" }] },
  drone: { label: "I · ♭II · I · iv", chords: [{ degree: 0, quality: "major", roman: "I" }, { degree: 1, quality: "major", roman: "♭II" }, { degree: 0, quality: "major", roman: "I" }, { degree: 5, quality: "minor", roman: "iv" }] }
};

const missions: { id: MissionId; label: string; detail: string }[] = [
  { id: "roots", label: "Roots only", detail: "Track structural motion" },
  { id: "thirds", label: "Thirds only", detail: "Hear chord quality from inside" },
  { id: "nearest", label: "Nearest chord tone", detail: "Minimize movement at every change" },
  { id: "shared", label: "Shared note", detail: "Stay still whenever harmony allows" },
  { id: "tension", label: "Tension → release", detail: "Color beat three; resolve on one" },
  { id: "free", label: "Chord-tone improv", detail: "Choose freely inside each sonority" }
];

const degreeLabels = ["1", "♭2", "2", "♭3", "3", "4", "♯4 / ♭5", "5", "♭6", "6", "♭7", "7"];

function midiNearMiddleC(pitchClass: number): number {
  const candidate = 60 + ((pitchClass % 12) + 12) % 12;
  return candidate > 71 ? candidate - 12 : candidate;
}

export function HarmonyLab() {
  const { tonicPitchClass, setTonicPitchClass, timbre, selectedMidi, setSelectedMidi, setView } = useLab();
  const [view, setHarmonyView] = useState<HarmonyView>("chordTone");
  const [presetId, setPresetId] = useState("pop");
  const [activeIndex, setActiveIndex] = useState(0);
  const [mission, setMission] = useState<MissionId>("nearest");
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(true);
  const [degreeMode, setDegreeMode] = useState<"recognize" | "produce">("recognize");
  const [scaleSetId, setScaleSetId] = useState("major");
  const [degreeTrial, setDegreeTrial] = useState(() => Math.floor(Math.random() * 12));
  const [degreeAnswer, setDegreeAnswer] = useState<number>();
  const [degreeRevealed, setDegreeRevealed] = useState(false);
  const timers = useRef<number[]>([]);
  const progression = progressionPresets[presetId];
  const active = progression.chords[activeIndex] ?? progression.chords[0];
  const activeRootPc = (tonicPitchClass + active.degree) % 12;
  const activeChord = CHORD_PRESETS[active.quality];
  const activePcs = activeChord.intervals.map((interval) => (activeRootPc + interval) % 12);
  const selectedPc = ((selectedMidi % 12) + 12) % 12;
  const isChordTone = activePcs.includes(selectedPc);
  const nearest = nearestResolutionPitchClasses(selectedPc, activePcs);
  const degreeScale = SCALE_PRESETS[scaleSetId] ?? SCALE_PRESETS.major;
  const degreeTargetMidi = midiNearMiddleC(tonicPitchClass) + degreeTrial;

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const chordMidi = (item: ProgressionChord) => {
    const rootPc = (tonicPitchClass + item.degree) % 12;
    const rootMidi = midiNearMiddleC(rootPc);
    return CHORD_PRESETS[item.quality].intervals.map((interval) => rootMidi + interval);
  };

  const playChord = (item = active) => void playFrequencies(chordMidi(item).map(continuousMidiToHz), "simultaneous", { timbre, duration: 1.35, amplitude: .26 });

  const playProgression = () => {
    timers.current.forEach(clearTimeout); timers.current = [];
    setPlaying(true);
    progression.chords.forEach((chord, index) => {
      timers.current.push(window.setTimeout(() => { setActiveIndex(index); playChord(chord); }, index * 1_650));
    });
    timers.current.push(window.setTimeout(() => setPlaying(false), progression.chords.length * 1_650));
  };

  const playDegreePrompt = () => {
    const tonicMidi = midiNearMiddleC(tonicPitchClass);
    const establishment = degreeScale.intervals.map((offset) => tonicMidi + offset).concat(tonicMidi + 12, tonicMidi);
    void playFrequencies(establishment.map(continuousMidiToHz), "sequential", { timbre, duration: .24, amplitude: .2 });
    timers.current.push(window.setTimeout(() => void playTone({ frequencyHz: continuousMidiToHz(degreeTargetMidi), timbre, duration: 1.05 }), establishment.length * 360));
  };

  const roleNotes = [
    { role: "Root", offset: 0, function: "1 · foundation" },
    { role: "Third", offset: activeChord.intervals[1] ?? 4, function: `${activeChord.intervals[1] === 3 ? "♭3" : "3"} · quality` },
    { role: "Fifth", offset: activeChord.intervals[2] ?? 7, function: "5 · support" },
    ...(activeChord.intervals[3] != null ? [{ role: "Seventh", offset: activeChord.intervals[3], function: `${activeChord.intervals[3] === 11 ? "7" : "♭7"} · color` }] : []),
    { role: "Ninth", offset: 14, function: "9 · diatonic tension" },
    { role: "♭Ninth", offset: 13, function: "♭9 · close friction" }
  ];

  const selectRole = (offset: number) => {
    const midi = midiNearMiddleC(activeRootPc) + offset;
    setSelectedMidi(midi);
    void playTone({ frequencyHz: continuousMidiToHz(midi), timbre, duration: .85 });
  };

  const sharedVoiceLines = useMemo(() => {
    const lines: number[][] = [];
    for (let toneIndex = 0; toneIndex < 3; toneIndex++) lines.push(progression.chords.map((chord) => chordMidi(chord)[Math.min(toneIndex, chordMidi(chord).length - 1)]));
    return lines;
  }, [presetId, tonicPitchClass]);

  return (
    <div className="page harmony-page">
      <div className="lab-intro">
        <div><Eyebrow>Function changes the meaning</Eyebrow><h1>Stand inside the chord.</h1><p>The same note can be home, support, shared glue, diatonic tension, or deliberate abrasion. Practice choosing the role.</p></div>
        <PlayButton label={playing ? "Progression playing" : "Play progression"} disabled={playing} onClick={playProgression} />
      </div>

      <Panel className="harmony-config">
        <Segmented value={view} onChange={setHarmonyView} options={[{ value: "scaleDegree", label: "Scale degrees" }, { value: "chordTone", label: "Chord tones" }, { value: "voiceLeading", label: "Voice leading" }, { value: "harmonyFollow", label: "Harmony following" }]} />
        <div className="harmony-fields"><Select label="Tonic" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>{Array.from({ length: 12 }, (_, pc) => <option key={pc} value={pc}>{pitchClassLabel(pc)}</option>)}</Select><Select label="Progression" value={presetId} onChange={(event) => { setPresetId(event.target.value); setActiveIndex(0); }}>{Object.entries(progressionPresets).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</Select><Select label="Mission" value={mission} onChange={(event) => setMission(event.target.value as MissionId)}>{missions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></div>
      </Panel>

      <Panel className="progression-strip">
        <div className="progression-heading"><div><Eyebrow>Manual harmony clock</Eyebrow><h2>{pitchClassLabel(tonicPitchClass)} · {progression.label}</h2></div><div className="transport"><button onClick={() => setActiveIndex(Math.max(0, activeIndex - 1))}>←</button><button className={playing ? "active" : ""} onClick={playProgression}><Icon name="play" size={16} /></button><button onClick={() => setActiveIndex(Math.min(progression.chords.length - 1, activeIndex + 1))}>→</button></div></div>
        <div className="chord-timeline">{progression.chords.map((chord, index) => { const rootPc = (tonicPitchClass + chord.degree) % 12; const pcs = CHORD_PRESETS[chord.quality].intervals.map((interval) => (rootPc + interval) % 12); return <button key={`${chord.roman}-${index}`} className={activeIndex === index ? "active" : ""} onClick={() => { setActiveIndex(index); playChord(chord); }}><small>BAR {index + 1}</small><strong>{pitchClassLabel(rootPc)}{chord.quality === "minor" ? "m" : chord.quality === "minor7" ? "m7" : chord.quality === "dominant7" ? "7" : chord.quality === "major7" ? "maj7" : ""}</strong><span>{chord.roman} · {pcs.map(pitchClassLabel).join(" ")}</span><i /></button>; })}</div>
        <div className="mission-banner"><Icon name="spark" size={19} /><span><small>CURRENT MISSION</small><b>{missions.find((item) => item.id === mission)?.label}</b></span><p>{missions.find((item) => item.id === mission)?.detail}</p></div>
      </Panel>

      {view === "scaleDegree" && <div className="scale-degree-workspace">
        <Panel className="tonal-prompt-card">
          <div className="panel-heading"><div><Eyebrow>Where is this relative to home?</Eyebrow><h2>{degreeMode === "recognize" ? "Hear the degree." : `Produce degree ${degreeLabels[degreeTrial]}.`}</h2></div><Segmented value={degreeMode} onChange={(value) => { setDegreeMode(value); setDegreeAnswer(undefined); setDegreeRevealed(false); }} options={[{ value: "recognize", label: "Recognize" }, { value: "produce", label: "Produce" }]} /></div>
          <div className="tonal-home-map"><div className="home-orb"><small>HOME</small><strong>{pitchClassLabel(tonicPitchClass)}</strong><span>{degreeScale.label}</span></div><div className="home-path"><span /><span /><span /><Icon name="arrow" size={18} /></div><div className="degree-orb"><small>{degreeMode === "recognize" ? "HEAR" : "SING"}</small><strong>{degreeRevealed || degreeMode === "produce" ? degreeLabels[degreeTrial] : "?"}</strong><span>{degreeRevealed ? noteLabel(degreeTargetMidi) : "relative position"}</span></div></div>
          <div className="degree-context-fields"><Select label="Tonic" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>{Array.from({ length: 12 }, (_, pc) => <option key={pc} value={pc}>{pitchClassLabel(pc)}</option>)}</Select><Select label="Set" value={scaleSetId} onChange={(event) => setScaleSetId(event.target.value)}>{Object.entries(SCALE_PRESETS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</Select></div>
          <PlayButton label={degreeMode === "recognize" ? "Establish tonic, then play note" : "Establish tonic"} onClick={playDegreePrompt} />
          <p>The cadence and scale create “home” before the chromatic degree appears. Its name is a relationship, not an isolated frequency.</p>
        </Panel>
        <Panel className="degree-answer-card">
          <Eyebrow>{degreeMode === "recognize" ? "Map the heard position" : "Motor prediction mission"}</Eyebrow>
          {degreeMode === "recognize" ? <><div className="degree-grid">{degreeLabels.map((label, offset) => <button key={label} disabled={degreeRevealed} className={`${degreeAnswer === offset ? "selected" : ""} ${degreeRevealed && degreeTrial === offset ? "correct" : ""} ${degreeRevealed && degreeAnswer === offset && degreeTrial !== offset ? "incorrect" : ""}`} onClick={() => setDegreeAnswer(offset)}><b>{label}</b><span>{pitchClassLabel(tonicPitchClass + offset)}</span><small>{degreeScale.intervals.includes(offset) ? "IN SET" : "CHROMATIC"}</small></button>)}</div>{degreeRevealed && <div className="degree-reading"><span>{degreeLabels[degreeTrial]}</span><div><b>{pitchClassLabel(tonicPitchClass + degreeTrial)} relative to {pitchClassLabel(tonicPitchClass)}</b><small>{degreeScale.intervals.includes(degreeTrial) ? `member of ${degreeScale.label}` : `chromatic color against ${degreeScale.label}`}</small></div></div>}<ActionButton className="wide primary" disabled={degreeAnswer == null} onClick={() => { if (!degreeRevealed) setDegreeRevealed(true); else { setDegreeTrial(Math.floor(Math.random() * 12)); setDegreeAnswer(undefined); setDegreeRevealed(false); } }}>{degreeRevealed ? "Next degree" : "Reveal function"}</ActionButton></> : <div className="degree-production"><span className="big-degree">{degreeLabels[degreeTrial]}</span><h3>The tonic is {pitchClassLabel(tonicPitchClass)}.</h3><p>Silently locate {pitchClassLabel(tonicPitchClass + degreeTrial)}, then begin directly without sliding.</p><div><PlayButton label="Hear tonic only" onClick={() => playTone({ frequencyHz: continuousMidiToHz(midiNearMiddleC(tonicPitchClass)), timbre, duration: 1.1 })} /><ActionButton className="primary" onClick={() => { setSelectedMidi(degreeTargetMidi); setView("mirror"); }}><Icon name="mic" size={17} /> Measure the landing</ActionButton></div><button className="text-button" onClick={() => setDegreeTrial(Math.floor(Math.random() * 12))}>New production degree <Icon name="spark" size={14} /></button></div>}
        </Panel>
      </div>}

      {view === "chordTone" && <div className="harmony-main-grid">
        <Panel className="chord-orbit-card">
          <div className="panel-heading"><div><Eyebrow>Current sonority</Eyebrow><h2>{pitchClassLabel(activeRootPc)} {activeChord.label}</h2></div><PlayButton label="Sound chord" onClick={() => playChord()} /></div>
          <div className="chord-orbit">
            <div className="orbit-ring outer" /><div className="orbit-ring inner" />
            {roleNotes.slice(0, Math.min(4, activeChord.intervals.length)).map((role, index) => { const angle = index * (360 / activeChord.intervals.length) - 90; return <button key={role.role} style={{ left: `${50 + 39 * Math.cos(angle * Math.PI / 180)}%`, top: `${50 + 39 * Math.sin(angle * Math.PI / 180)}%` }} className={selectedPc === (activeRootPc + role.offset) % 12 ? "selected" : ""} onClick={() => selectRole(role.offset)}><small>{role.role}</small><b>{pitchClassLabel((activeRootPc + role.offset) % 12)}</b></button>; })}
            <div className="orbit-center"><small>ROOT</small><strong>{pitchClassLabel(activeRootPc)}</strong><span>{active.roman}</span></div>
          </div>
          <div className="chord-spelling">{activePcs.map((pc, index) => <span key={pc}><small>{["ROOT", "THIRD", "FIFTH", "SEVENTH"][index]}</small><b>{pitchClassLabel(pc)}</b></span>)}</div>
        </Panel>
        <Panel className="role-missions-card">
          <div className="panel-heading"><div><Eyebrow>Choose a function</Eyebrow><h2>Sing from inside</h2></div><button className="icon-button" onClick={() => setReveal(!reveal)}><Icon name={reveal ? "eyeOff" : "eye"} /></button></div>
          <div className="role-list">{roleNotes.map((role) => { const pc = (activeRootPc + role.offset) % 12; const inChord = activePcs.includes(pc); return <button key={role.role} className={`${selectedPc === pc ? "selected" : ""} ${!inChord ? "tension" : ""}`} onClick={() => selectRole(role.offset)}><span className="role-index">{pitchClassLabel(pc)}</span><span><b>{role.role}</b><small>{reveal ? role.function : "function hidden"}</small></span><i>{inChord ? "CHORD" : "COLOR"}</i><Icon name="play" size={16} /></button>; })}</div>
          <ActionButton className="wide primary" onClick={() => setView("mirror")}><Icon name="mic" size={17} /> Measure {noteLabel(selectedMidi)} in Pitch Mirror</ActionButton>
        </Panel>
        <Panel className="selected-function-card">
          <Eyebrow>Selected note in context</Eyebrow><div className="function-note"><strong>{pitchClassLabel(selectedPc)}</strong><span>over</span><b>{pitchClassLabel(activeRootPc)} {activeChord.label.toLowerCase()}</b></div><h2>{isChordTone ? "Chord tone · structurally stable" : "Intentional tension · asking for motion"}</h2><p>{isChordTone ? "Reinforce the chord, linger, or use it as a landing point." : `Nearest stable options are ${nearest.map(pitchClassLabel).join(" or ")}. The note is not “wrong”; its continuation defines its function.`}</p><div className="resolution-route"><span>{pitchClassLabel(selectedPc)}</span><i>→</i>{nearest.map((pc) => <button key={pc} onClick={() => selectRole((pc - activeRootPc + 12) % 12)}>{pitchClassLabel(pc)}</button>)}</div>
        </Panel>
      </div>}

      {view === "voiceLeading" && <div className="harmony-main-grid voice-leading-view">
        <Panel className="voice-map-card"><div className="panel-heading"><div><Eyebrow>Motion across changes</Eyebrow><h2>Three possible voices</h2></div><span className="local-badge">nearest paths</span></div><svg viewBox={`0 0 ${progression.chords.length * 220} 360`} preserveAspectRatio="none">{[0, 1, 2].map((line) => <path key={line} d={sharedVoiceLines[line].map((midi, index) => `${index ? "L" : "M"} ${110 + index * 220} ${320 - (midi - 48) * 10}`).join(" ")} className={`voice-line line-${line}`} />)}{progression.chords.map((chord, chordIndex) => chordMidi(chord).slice(0, 3).map((midi, toneIndex) => <g key={`${chordIndex}-${toneIndex}`}><circle cx={110 + chordIndex * 220} cy={320 - (midi - 48) * 10} r="18" className={`voice-node line-${toneIndex}`} /><text x={110 + chordIndex * 220} y={326 - (midi - 48) * 10} textAnchor="middle">{pitchClassLabel(midi)}</text></g>))}</svg><div className="voice-chord-labels">{progression.chords.map((chord, index) => <span key={index}>{chord.roman}<small>{pitchClassLabel((tonicPitchClass + chord.degree) % 12)}</small></span>)}</div></Panel>
        <Panel className="voice-mission-list"><Eyebrow>Voice-leading missions</Eyebrow><h2>Change the constraint.</h2>{missions.slice(0, 5).map((item) => <button className={mission === item.id ? "selected" : ""} key={item.id} onClick={() => setMission(item.id)}><Icon name="arrow" size={17} /><span><b>{item.label}</b><small>{item.detail}</small></span></button>)}</Panel>
      </div>}

      {view === "harmonyFollow" && <div className="harmony-main-grid follow-view">
        <Panel className="follow-card"><Eyebrow>Same melody · different rule</Eyebrow><h2>Where fixed thirds break.</h2><div className="melody-lanes"><div><span>MELODY</span>{[0, 2, 4, 5, 7, 5, 4, 2].map((offset, index) => <i key={index} style={{ transform: `translateY(${-offset * 3}px)` }} />)}</div><div><span>FIXED +3</span>{[3, 5, 7, 8, 10, 8, 7, 5].map((offset, index) => <i key={index} className={index === 4 ? "clash" : ""} style={{ transform: `translateY(${-offset * 3}px)` }} />)}</div><div><span>CHORD-AWARE</span>{[4, 4, 4, 5, 7, 5, 4, 4].map((offset, index) => <i key={index} className="aware" style={{ transform: `translateY(${-offset * 3}px)` }} />)}</div></div><p>A fixed interval preserves geometry. Chord-aware harmony preserves function. Hear both, then choose deliberately.</p></Panel>
        <Panel className="follow-modes"><Eyebrow>Following constraint</Eyebrow><h2>Build the second line</h2>{["Unison", "Octave", "Fixed third above", "Nearest chord tone", "Contrary motion", "Free chord-constrained"].map((item, index) => <button key={item}><span>{String(index + 1).padStart(2, "0")}</span><b>{item}</b><Icon name="play" size={16} /></button>)}</Panel>
      </div>}
    </div>
  );
}
