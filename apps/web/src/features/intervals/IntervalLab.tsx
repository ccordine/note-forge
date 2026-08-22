import { useMemo, useState } from "react";
import { playFrequencies, playTone } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import { continuousMidiToHz, INTERVAL_LONG, INTERVAL_SHORT, noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

type ExerciseType = "recognition" | "production" | "comparison" | "mutation";
type Presentation = "ascending" | "descending" | "harmonic";

interface IntervalTrial { start: number; semitones: number; presentation: Presentation; }

function randomTrial(presentation?: Presentation): IntervalTrial {
  return { start: 48 + Math.floor(Math.random() * 15), semitones: 1 + Math.floor(Math.random() * 12), presentation: presentation ?? (["ascending", "descending", "harmonic"] as const)[Math.floor(Math.random() * 3)] };
}

function trialNotes(trial: IntervalTrial): [number, number] {
  return [trial.start, trial.presentation === "descending" ? trial.start - trial.semitones : trial.start + trial.semitones];
}

function IntervalSteps({ semitones, revealed }: { semitones: number; revealed: boolean }) {
  return <div className="interval-steps" aria-label={`${semitones} semitone distance`}><span className="step-origin">A</span>{Array.from({ length: 13 }, (_, index) => <i key={index} className={index <= semitones ? "filled" : ""}>{index === semitones ? <b>B</b> : ""}</i>)}<em>{revealed ? `${semitones} semitones` : "distance hidden"}</em></div>;
}

export function IntervalLab() {
  const { timbre, setSelectedMidi, setView } = useLab();
  const [exercise, setExercise] = useState<ExerciseType>("recognition");
  const [presentation, setPresentation] = useState<Presentation>("ascending");
  const [soundFirst, setSoundFirst] = useState(true);
  const [trial, setTrial] = useState(() => randomTrial("ascending"));
  const [answer, setAnswer] = useState<number>();
  const [revealed, setRevealed] = useState(false);
  const [compareTrial, setCompareTrial] = useState(() => ({ a: randomTrial("ascending"), b: randomTrial("ascending") }));
  const [comparisonAnswer, setComparisonAnswer] = useState<"a" | "b" | "same">();
  const [score, setScore] = useState({ right: 0, total: 0 });
  const notes = trialNotes(trial);

  const playInterval = (source = trial) => {
    const pair = trialNotes(source).map(continuousMidiToHz);
    void playFrequencies(pair, source.presentation === "harmonic" ? "simultaneous" : "sequential", { timbre, duration: .82 });
  };

  const nextRecognition = () => {
    const next = randomTrial(presentation);
    setTrial(next); setAnswer(undefined); setRevealed(false);
  };

  const submitRecognition = () => {
    if (answer == null) return;
    setScore((current) => ({ right: current.right + (answer === trial.semitones ? 1 : 0), total: current.total + 1 }));
    setRevealed(true);
  };

  const correctComparison = compareTrial.a.semitones === compareTrial.b.semitones ? "same" : compareTrial.a.semitones > compareTrial.b.semitones ? "a" : "b";
  const phrase = useMemo(() => [0, 2, 5, 3].map((offset) => trial.start + offset), [trial.start]);

  return (
    <div className="page interval-page">
      <div className="lab-intro">
        <div><Eyebrow>Distance is its own object</Eyebrow><h1>Hear the movement before its name.</h1><p>Recognize, produce, compare, and mutate intervals in separate tasks. The label can wait until the phenomenon is clear.</p></div>
        <div className="interval-score"><span>{score.right}<small>mapped</small></span><i>/</i><span>{score.total}<small>attempted</small></span></div>
      </div>

      <Panel className="interval-config">
        <Segmented value={exercise} onChange={setExercise} options={[{ value: "recognition", label: "Recognition" }, { value: "production", label: "Production" }, { value: "comparison", label: "Comparison" }, { value: "mutation", label: "Mutation" }]} />
        <Segmented label="Presentation" value={presentation} onChange={(value) => { setPresentation(value); setTrial(randomTrial(value)); setRevealed(false); }} options={[{ value: "ascending", label: "Ascending" }, { value: "descending", label: "Descending" }, { value: "harmonic", label: "Together" }]} />
        <Switch label="Sound first" checked={soundFirst} onChange={setSoundFirst} />
      </Panel>

      {exercise === "recognition" && <div className="interval-workspace">
        <Panel className="interval-listen-card">
          <div className="trial-index">RELATIONSHIP {String(score.total + 1).padStart(2, "0")} <span /> {presentation}</div>
          <button className="interval-orb" onClick={() => playInterval()} aria-label="Play interval"><span className="note-a">A</span><i><span /><span /><span /><span /></i><span className="note-b">B</span><Icon name="play" size={23} /></button>
          <h2>{revealed || !soundFirst ? `${INTERVAL_LONG[trial.semitones]}` : "What did the distance feel like?"}</h2>
          <p>{revealed || !soundFirst ? `${INTERVAL_SHORT[trial.semitones]} · ${trial.semitones} semitones · ${notes.map(noteLabel).join(" → ")}` : "Replay it, sing it back if useful, then choose a relationship."}</p>
          <IntervalSteps semitones={trial.semitones} revealed={revealed || !soundFirst} />
          <PlayButton label="Replay" onClick={() => playInterval()} />
        </Panel>
        <Panel className="interval-answer-card">
          <Eyebrow>Choose the relationship</Eyebrow>
          <div className="interval-answer-grid">{Array.from({ length: 13 }, (_, semitones) => <button key={semitones} className={`${answer === semitones ? "selected" : ""} ${revealed && semitones === trial.semitones ? "correct" : ""} ${revealed && answer === semitones && answer !== trial.semitones ? "incorrect" : ""}`} disabled={revealed} onClick={() => setAnswer(semitones)}><span>{INTERVAL_SHORT[semitones]}</span><b>{INTERVAL_LONG[semitones]}</b><small>{semitones} st</small></button>)}</div>
          {revealed && <div className={`interval-result ${answer === trial.semitones ? "correct" : "review"}`}><Icon name={answer === trial.semitones ? "spark" : "ear"} size={20} /><div><b>{answer === trial.semitones ? "Distance mapped." : `${INTERVAL_SHORT[answer ?? 0]} ↔ ${INTERVAL_SHORT[trial.semitones]} logged as a confusion.`}</b><span>Now hear it once more with the name attached.</span></div><button onClick={() => playInterval()}><Icon name="play" size={15} /></button></div>}
          <ActionButton className="wide primary" disabled={answer == null} onClick={revealed ? nextRecognition : submitRecognition}>{revealed ? <>Next interval <Icon name="arrow" size={17} /></> : "Reveal relationship"}</ActionButton>
        </Panel>
      </div>}

      {exercise === "production" && <div className="interval-workspace production">
        <Panel className="production-mission">
          <div className="mission-number">PRODUCTION MISSION</div>
          <div className="start-note-disc"><small>START</small><strong>{soundFirst ? "•" : noteLabel(notes[0])}</strong><button onClick={() => playTone({ frequencyHz: continuousMidiToHz(notes[0]), timbre, duration: 1.05 })}><Icon name="play" size={18} /></button></div>
          <div className="mission-arrow"><span>{presentation === "descending" ? "↓" : "↑"}</span><small>{trial.semitones} semitones</small></div>
          <div className="target-note-disc"><small>SING</small><strong>{INTERVAL_SHORT[trial.semitones]}</strong><span>{presentation}</span></div>
          <h2>Sing a {INTERVAL_LONG[trial.semitones]} {presentation === "descending" ? "below" : "above"}.</h2>
          <p>Only the starting note sounds. Predict the second pitch, silently configure, then produce.</p>
          <div className="production-actions"><PlayButton label="Hear start" onClick={() => playTone({ frequencyHz: continuousMidiToHz(notes[0]), timbre, duration: 1.05 })} /><ActionButton className="primary" onClick={() => { setSelectedMidi(notes[1]); setView("mirror"); }}><Icon name="mic" size={18} /> Measure in Pitch Mirror</ActionButton><ActionButton onClick={nextRecognition}>New mission</ActionButton></div>
        </Panel>
        <Panel className="production-map"><Eyebrow>After you produce</Eyebrow><h2>Reveal the landing coordinate</h2><p>The interval score belongs to the distance between both produced centers, so two sharp notes can still describe an accurate interval.</p><button className="reveal-landing" onClick={() => setRevealed(!revealed)}><Icon name={revealed ? "eyeOff" : "eye"} />{revealed ? <><b>{noteLabel(notes[1])}</b><span>{continuousMidiToHz(notes[1]).toFixed(2)} Hz</span></> : <span>Reveal landing note</span>}</button><div className="formula-card"><span>Δ actual</span><b>1200 log₂ (f₂ / f₁)</b><small>continuous cents · no early snapping</small></div></Panel>
      </div>}

      {exercise === "comparison" && <div className="interval-workspace comparison">
        <Panel className="comparison-card">
          <Eyebrow>Two candidate movements</Eyebrow><h2>Which distance is wider?</h2><div className="candidate-intervals"><button onClick={() => playInterval(compareTrial.a)}><span>A</span><i>{soundFirst && !revealed ? "?" : INTERVAL_SHORT[compareTrial.a.semitones]}</i><Icon name="play" /></button><b>versus</b><button onClick={() => playInterval(compareTrial.b)}><span>B</span><i>{soundFirst && !revealed ? "?" : INTERVAL_SHORT[compareTrial.b.semitones]}</i><Icon name="play" /></button></div><ActionButton className="wide" onClick={() => { playInterval(compareTrial.a); setTimeout(() => playInterval(compareTrial.b), 2_100); }}>Play A, then B</ActionButton>
        </Panel>
        <Panel className="comparison-answer"><Eyebrow>Your comparison</Eyebrow><div className="wide-choice">{(["a", "same", "b"] as const).map((choice) => <button key={choice} className={`${comparisonAnswer === choice ? "selected" : ""} ${revealed && correctComparison === choice ? "correct" : ""}`} onClick={() => !revealed && setComparisonAnswer(choice)}>{choice === "a" ? "A is wider" : choice === "b" ? "B is wider" : "Identical"}</button>)}</div>{revealed && <div className="comparison-reveal"><b>{INTERVAL_SHORT[compareTrial.a.semitones]} · {compareTrial.a.semitones} st</b><span>versus</span><b>{INTERVAL_SHORT[compareTrial.b.semitones]} · {compareTrial.b.semitones} st</b></div>}<ActionButton className="wide primary" disabled={!comparisonAnswer} onClick={() => { if (!revealed) setRevealed(true); else { setCompareTrial({ a: randomTrial("ascending"), b: randomTrial("ascending") }); setComparisonAnswer(undefined); setRevealed(false); } }}>{revealed ? "Next comparison" : "Reveal distances"}</ActionButton></Panel>
      </div>}

      {exercise === "mutation" && <div className="interval-workspace mutation">
        <Panel className="mutation-phrase"><Eyebrow>Imitation becomes control</Eyebrow><h2>Hear this gesture.</h2><div className="phrase-notes">{phrase.map((midi, index) => <span key={index} style={{ transform: `translateY(${-(midi - trial.start) * 5}px)` }}>{soundFirst ? "•" : noteLabel(midi)}</span>)}</div><PlayButton label="Play phrase" onClick={() => playFrequencies(phrase.map(continuousMidiToHz), "sequential", { timbre, duration: .46 })} /></Panel>
        <Panel className="mutation-missions"><Eyebrow>Now mutate it</Eyebrow><h2>Preserve one thing; change another.</h2>{[{ label: "Unchanged", detail: "Copy contour, register, and intervals", shift: 0 }, { label: "Octave higher", detail: "Keep pitch classes and contour", shift: 12 }, { label: "A third above", detail: "Transpose every movement by M3", shift: 4 }].map((mission) => <button key={mission.label} onClick={() => playFrequencies(phrase.map((midi) => continuousMidiToHz(midi + mission.shift)), "sequential", { timbre, duration: .46 })}><span><b>{mission.label}</b><small>{mission.detail}</small></span><Icon name="play" size={18} /></button>)}</Panel>
      </div>}
    </div>
  );
}
