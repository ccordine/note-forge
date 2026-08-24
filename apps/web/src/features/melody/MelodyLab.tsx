import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { splitMidiPitch } from "@noteforge/music-core";
import { playFrequencies, playPitchContour, playSafely } from "@/audio/synth";
import { continuousMidiToHz, noteLabel } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

type MelodyMode = "echo" | "contour" | "draw" | "transcribe";

const shapes = [
  { label: "rising arch", offsets: [0, 2, 4, 7, 5, 2] },
  { label: "descending steps", offsets: [7, 5, 4, 2, 0] },
  { label: "same · up · up · drop", offsets: [0, 0, 2, 4, -3] },
  { label: "valley", offsets: [5, 2, 0, 2, 5] }
];

function generatePhrase(length: number, chromatic: boolean, root = 60): number[] {
  const allowed = chromatic ? Array.from({ length: 13 }, (_, i) => i - 2) : [0, 2, 4, 5, 7, 9, 11, 12];
  const phrase = [root];
  for (let index = 1; index < length; index++) {
    const previous = phrase[index - 1];
    const choices = allowed.map((offset) => root + offset).filter((midi) => Math.abs(midi - previous) <= 7);
    phrase.push(choices[Math.floor(Math.random() * choices.length)]);
  }
  return phrase;
}

function ContourGlyph({ notes, hidden = false }: { notes: readonly number[]; hidden?: boolean }) {
  const min = Math.min(...notes); const max = Math.max(...notes); const range = Math.max(1, max - min);
  const points = notes.map((note, index) => `${20 + index * (560 / Math.max(1, notes.length - 1))},${150 - ((note - min) / range) * 105}`).join(" ");
  return <svg className="contour-glyph" viewBox="0 0 600 180" preserveAspectRatio="none"><line x1="0" x2="600" y1="150" y2="150" /><polyline points={points} />{notes.map((note, index) => { const [x, y] = points.split(" ")[index].split(","); return <g key={index}><circle cx={x} cy={y} r="7" /><text x={x} y={Number(y) - 17} textAnchor="middle">{hidden ? "•" : noteLabel(note)}</text></g>; })}</svg>;
}

export function MelodyLab() {
  const { timbre, tonicPitchClass, labelsHidden, setLabelsHidden, setSelectedMidi, setView } = useLab();
  const [mode, setMode] = useState<MelodyMode>("echo");
  const [length, setLength] = useState(4);
  const [chromatic, setChromatic] = useState(false);
  const [phrase, setPhrase] = useState(() => generatePhrase(4, false));
  const [revealed, setRevealed] = useState(false);
  const [shapeIndex, setShapeIndex] = useState(0);
  const [shapeAnswer, setShapeAnswer] = useState<number>();
  const [drawnPoints, setDrawnPoints] = useState<{ x: number; y: number }[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [transcription, setTranscription] = useState<(number | null)[]>(Array(8).fill(null));
  const drawingRef = useRef<SVGSVGElement>(null);
  const rootMidi = 60 + tonicPitchClass;
  const shapeNotes = shapes[shapeIndex].offsets.map((offset) => rootMidi + offset);

  const newPhrase = () => { setPhrase(generatePhrase(length, chromatic, rootMidi)); setRevealed(false); };
  const playPhrase = (notes = phrase) => playSafely(playFrequencies(notes.map(continuousMidiToHz), "sequential", { timbre, duration: .48, amplitude: .25 }), "Melody playback");
  const changeMode = (nextMode: MelodyMode) => {
    setMode(nextMode);
    setRevealed(false);
    setShapeAnswer(undefined);
    setDrawing(false);
  };

  const addDrawPoint = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing) return;
    const rect = drawingRef.current!.getBoundingClientRect();
    const point = { x: Math.max(0, Math.min(600, (event.clientX - rect.left) / rect.width * 600)), y: Math.max(0, Math.min(220, (event.clientY - rect.top) / rect.height * 220)) };
    setDrawnPoints((current) => {
      if (current.length && point.x < current[current.length - 1].x + 3) return current;
      return [...current.slice(-199), point];
    });
  };
  const drawnMidi = useMemo(() => drawnPoints.map((point) => 72 - (point.y / 220) * 24), [drawnPoints]);
  const drawPath = drawnPoints.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");

  const toggleTranscribedNote = (column: number, midi: number) => setTranscription((current) => current.map((value, index) => index === column ? (value === midi ? null : midi) : value));

  return (
    <div className="page melody-page">
      <div className="lab-intro"><div><Eyebrow>Shape → notes → embodied phrase</Eyebrow><h1>Hold a gesture long enough to change it.</h1><p>Echo exact pitches, isolate contour, draw a continuous vocal path, or turn hearing into a piano-roll plan.</p></div><Switch label="Hide note labels" checked={labelsHidden} onChange={setLabelsHidden} /></div>
      <Panel className="melody-config"><Segmented value={mode} onChange={changeMode} options={[{ value: "echo", label: "Call & response" }, { value: "contour", label: "Contour" }, { value: "draw", label: "Pitch drawing" }, { value: "transcribe", label: "Transcription" }]} /><div className="melody-fields"><Select label="Notes" value={length} onChange={(event) => { const value = Number(event.target.value); setLength(value); setPhrase(generatePhrase(value, chromatic, rootMidi)); setRevealed(false); }}><option value="2">2 notes</option><option value="3">3 notes</option><option value="4">4 notes</option><option value="6">6 notes</option><option value="8">8 notes</option></Select><Switch label="Allow chromatic notes" checked={chromatic} onChange={(value) => { setChromatic(value); setPhrase(generatePhrase(length, value, rootMidi)); setRevealed(false); }} /></div></Panel>

      {mode === "echo" && <div className="melody-grid">
        <Panel className="phrase-stage"><div className="trial-index">CALL · {length} NOTES <span /> {chromatic ? "chromatic allowed" : "diatonic"}</div><button className="phrase-play-orb" onClick={() => playPhrase()}><Icon name="play" size={27} /><span>HEAR CALL</span></button><ContourGlyph notes={phrase} hidden={labelsHidden && !revealed} /><h2>Reproduce the phrase in one breath.</h2><p>Keep the contour first. Exact centers can arrive on the next pass.</p><div className="stage-actions"><PlayButton label="Replay call" onClick={() => playPhrase()} /><ActionButton className="primary" onClick={() => { setSelectedMidi(phrase[0]); setView("mirror"); }}><Icon name="mic" size={17} /> Open response mirror</ActionButton></div></Panel>
        <Panel className="phrase-variables"><Eyebrow>Difficulty is multidimensional</Eyebrow><h2>Change one pressure.</h2>{[{ label: "Note count", value: `${length}` }, { label: "Largest leap", value: `${Math.max(...phrase.slice(1).map((note, i) => Math.abs(note - phrase[i])))} st` }, { label: "Playback count", value: "unlimited" }, { label: "Starting note", value: labelsHidden ? "hidden" : noteLabel(phrase[0]) }, { label: "Key membership", value: chromatic ? "mixed" : "major" }].map((item) => <div key={item.label}><span>{item.label}</span><b>{item.value}</b></div>)}<button className="reveal-phrase" onClick={() => setRevealed(!revealed)}><Icon name={revealed ? "eyeOff" : "eye"} /> {revealed ? phrase.map(noteLabel).join(" · ") : "Reveal exact notes"}</button><ActionButton className="wide" onClick={newPhrase}><Icon name="spark" size={16} /> Generate another phrase</ActionButton></Panel>
      </div>}

      {mode === "contour" && <div className="melody-grid contour-mode">
        <Panel className="contour-prompt"><Eyebrow>Labels removed</Eyebrow><h2>Which shape moved?</h2><div className="abstract-contour"><ContourGlyph notes={shapeNotes} hidden /></div><PlayButton label="Hear contour" onClick={() => playPhrase(shapeNotes)} /><p>Track sameness, direction, and relative leap size before exact pitch.</p></Panel>
        <Panel className="shape-answers"><Eyebrow>Choose the gesture</Eyebrow>{shapes.map((shape, index) => <button key={shape.label} className={`${shapeAnswer === index ? "selected" : ""} ${revealed && index === shapeIndex ? "correct" : ""}`} onClick={() => !revealed && setShapeAnswer(index)}><span>{shape.offsets.map((offset, i) => i === 0 ? "•" : offset === shape.offsets[i - 1] ? "→" : offset > shape.offsets[i - 1] ? "↗" : "↘").join(" ")}</span><b>{shape.label}</b></button>)}<ActionButton className="wide primary" disabled={shapeAnswer == null} onClick={() => { if (!revealed) setRevealed(true); else { let next = Math.floor(Math.random() * shapes.length); if (next === shapeIndex) next = (next + 1) % shapes.length; setShapeIndex(next); setShapeAnswer(undefined); setRevealed(false); } }}>{revealed ? "Next contour" : "Reveal shape"}</ActionButton></Panel>
      </div>}

      {mode === "draw" && <div className="draw-workspace">
        <Panel className="draw-stage"><div className="panel-heading"><div><Eyebrow>Voice is continuous</Eyebrow><h2>Draw a vocal gesture.</h2></div><button className="text-button" onClick={() => setDrawnPoints([])}>Clear</button></div><div className="pitch-canvas"><div className="draw-labels"><span>high</span><span>center</span><span>low</span></div><svg ref={drawingRef} viewBox="0 0 600 220" preserveAspectRatio="none" onPointerDown={(event) => { if (event.button !== 0) return; setDrawing(true); setDrawnPoints([]); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={addDrawPoint} onPointerUp={(event) => { setDrawing(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => setDrawing(false)} onLostPointerCapture={() => setDrawing(false)}><defs><pattern id="draw-grid" width="50" height="36.6" patternUnits="userSpaceOnUse"><path d="M50 0H0V36.6" /></pattern><linearGradient id="draw-line"><stop stopColor="#63d7ff" /><stop offset=".5" stopColor="#d8ff3e" /><stop offset="1" stopColor="#ff6b45" /></linearGradient></defs><rect width="600" height="220" fill="url(#draw-grid)" /><line x1="0" x2="600" y1="110" y2="110" />{drawPath ? <><path d={drawPath} className="drawn-glow" /><path d={drawPath} className="drawn-line" /></> : <text x="300" y="118" textAnchor="middle">press · draw · hear · embody</text>}</svg></div><div className="draw-actions"><ActionButton disabled={drawnMidi.length < 2} onClick={() => playSafely(playPitchContour(drawnMidi, 2.8), "Drawn pitch contour")}><Icon name="play" size={17} /> Synthesize drawing</ActionButton><ActionButton className="primary" disabled={drawnMidi.length < 2} onClick={() => { setSelectedMidi(splitMidiPitch(drawnMidi[0] ?? 60).nearestMidi); setView("mirror"); }}><Icon name="mic" size={17} /> Reproduce it</ActionButton></div></Panel>
        <Panel className="manifest-note"><span className="manifest-symbol">∿</span><Eyebrow>Visual → auditory → motor</Eyebrow><h2>A contour is a plan for motion.</h2><p>The synthesizer keeps this drawing continuous. It is not rounded to piano keys before you hear it.</p><dl><div><dt>Start</dt><dd>{drawnMidi[0] == null ? "—" : noteLabel(splitMidiPitch(drawnMidi[0]).nearestMidi)}</dd></div><div><dt>Range</dt><dd>{drawnMidi.length ? `${(Math.max(...drawnMidi) - Math.min(...drawnMidi)).toFixed(1)} st` : "—"}</dd></div><div><dt>Samples</dt><dd>{drawnMidi.length}</dd></div></dl></Panel>
      </div>}

      {mode === "transcribe" && <div className="transcribe-workspace">
        <Panel className="transcription-source"><Eyebrow>Hearing → symbols → voice</Eyebrow><h2>Place what you heard.</h2><PlayButton label="Play source phrase" onClick={() => playPhrase(phrase)} /><ContourGlyph notes={phrase} hidden={!revealed} /><button className="text-button" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide source notes" : "Reveal source after attempt"}</button></Panel>
        <Panel className="piano-roll-card"><div className="panel-heading"><div><Eyebrow>Your symbolic reading</Eyebrow><h2>Eight-step piano roll</h2></div><span>{transcription.filter(Boolean).length}/8 placed</span></div><div className="mini-piano-roll"><div className="roll-labels">{Array.from({ length: 13 }, (_, row) => 72 - row).map((midi) => <span key={midi}>{noteLabel(midi)}</span>)}</div><div className="roll-grid">{Array.from({ length: 13 }, (_, row) => 72 - row).flatMap((midi) => Array.from({ length: 8 }, (_, column) => <button key={`${midi}-${column}`} className={transcription[column] === midi ? "active" : ""} onClick={() => toggleTranscribedNote(column, midi)} aria-label={`Step ${column + 1}: ${noteLabel(midi)}`} />))}</div></div><div className="draw-actions"><ActionButton disabled={!transcription.some(Boolean)} onClick={() => playPhrase(transcription.filter((note): note is number => note != null))}><Icon name="play" size={17} /> Hear transcription</ActionButton><ActionButton className="primary" disabled={!transcription.some(Boolean)} onClick={() => { const first = transcription.find((note): note is number => note != null); if (first != null) { setSelectedMidi(first); setView("mirror"); } }}><Icon name="mic" size={17} /> Sing what you wrote</ActionButton></div></Panel>
      </div>}
    </div>
  );
}
