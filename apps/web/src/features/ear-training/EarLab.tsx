import { useEffect, useMemo, useState } from "react";
import { playFrequencies, playTone, TIMBRES, type Timbre } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import { continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";

type EarMode = "sameDifferent" | "direction" | "reference" | "pitchClass" | "octave" | "complete" | "family";

const modes: { value: EarMode; label: string }[] = [
  { value: "sameDifferent", label: "Same / different" },
  { value: "direction", label: "Higher / lower" },
  { value: "reference", label: "Known anchor" },
  { value: "pitchClass", label: "Pitch class" },
  { value: "octave", label: "Octave only" },
  { value: "complete", label: "Full note" },
  { value: "family", label: "Octave family" }
];

interface Trial {
  firstMidi: number;
  targetMidi: number;
  timbreA: Timbre;
  timbreB: Timbre;
}

function newTrial(mode: EarMode, crossTimbre: boolean): Trial {
  const timbreA = TIMBRES[Math.floor(Math.random() * TIMBRES.length)];
  const timbreB = crossTimbre ? TIMBRES[Math.floor(Math.random() * TIMBRES.length)] : timbreA;
  const targetMidi = 48 + Math.floor(Math.random() * 25);
  let firstMidi = 69;
  if (mode === "sameDifferent") firstMidi = Math.random() < 0.45 ? targetMidi : Math.max(45, Math.min(76, targetMidi + [-5, -2, -1, 1, 2, 5][Math.floor(Math.random() * 6)]));
  if (mode === "direction") firstMidi = Math.max(45, Math.min(76, targetMidi + (Math.random() < 0.5 ? -(1 + Math.floor(Math.random() * 7)) : 1 + Math.floor(Math.random() * 7))));
  return { firstMidi, targetMidi, timbreA, timbreB };
}

export function EarLab() {
  const { timbre, labelsHidden, setLabelsHidden, setSelectedMidi } = useLab();
  const [mode, setMode] = useState<EarMode>("pitchClass");
  const [crossTimbre, setCrossTimbre] = useState(true);
  const [trial, setTrial] = useState(() => newTrial("pitchClass", true));
  const [pitchClassAnswer, setPitchClassAnswer] = useState<number>();
  const [octaveAnswer, setOctaveAnswer] = useState<number>();
  const [simpleAnswer, setSimpleAnswer] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState({ pitchClass: 0, octave: 0, direction: 0, attempts: 0 });

  useEffect(() => {
    setTrial(newTrial(mode, crossTimbre));
    setPitchClassAnswer(undefined); setOctaveAnswer(undefined); setSimpleAnswer(undefined); setSubmitted(false);
  }, [mode, crossTimbre]);

  const targetPc = ((trial.targetMidi % 12) + 12) % 12;
  const targetOctave = Math.floor(trial.targetMidi / 12) - 1;
  const correctSimple = mode === "sameDifferent" ? (trial.firstMidi === trial.targetMidi ? "same" : "different") : trial.targetMidi > trial.firstMidi ? "higher" : "lower";

  const playTrial = () => {
    if (mode === "pitchClass" || mode === "octave" || mode === "complete") {
      void playTone({ frequencyHz: continuousMidiToHz(trial.targetMidi), timbre: crossTimbre ? trial.timbreB : timbre, duration: 1.15 });
    } else if (mode === "reference") {
      void playFrequencies([440, continuousMidiToHz(trial.targetMidi)], "sequential", { timbre: crossTimbre ? trial.timbreB : timbre, duration: 0.9 });
    } else if (mode === "family") {
      const pc = targetPc;
      const notes = [36 + pc, 48 + pc, 60 + pc, 72 + pc].filter((midi) => midi >= 40 && midi <= 84);
      void playFrequencies(notes.map((midi) => continuousMidiToHz(midi)), "sequential", { timbre: crossTimbre ? trial.timbreB : timbre, duration: 0.55 });
    } else {
      void playFrequencies([continuousMidiToHz(trial.firstMidi), continuousMidiToHz(trial.targetMidi)], "sequential", { timbre: crossTimbre ? trial.timbreB : timbre, duration: 0.72 });
    }
  };

  const submit = () => {
    if (submitted) return;
    const pcCorrect = pitchClassAnswer === targetPc;
    const octaveCorrect = octaveAnswer === targetOctave;
    const simpleCorrect = simpleAnswer === correctSimple;
    setScore((current) => ({
      pitchClass: current.pitchClass + (pcCorrect ? 1 : 0),
      octave: current.octave + (octaveCorrect ? 1 : 0),
      direction: current.direction + (simpleCorrect ? 1 : 0),
      attempts: current.attempts + 1
    }));
    setSubmitted(true);
    setSelectedMidi(trial.targetMidi);
  };

  const next = () => {
    setTrial(newTrial(mode, crossTimbre));
    setPitchClassAnswer(undefined); setOctaveAnswer(undefined); setSimpleAnswer(undefined); setSubmitted(false);
  };

  const canSubmit = mode === "sameDifferent" || mode === "direction" ? simpleAnswer != null : mode === "complete" ? pitchClassAnswer != null && octaveAnswer != null : mode === "octave" ? octaveAnswer != null : pitchClassAnswer != null;
  const primaryPrompt = mode === "sameDifferent" ? "Did the pitch change?" : mode === "direction" ? "Where did the second sound move?" : mode === "reference" ? "Navigate from A4 to the second note." : mode === "family" ? "What remains constant across registers?" : mode === "octave" ? "Which register contains the sound?" : mode === "complete" ? "Name both identity and register." : "Name the pitch class. Ignore register.";
  const resultCorrect = mode === "sameDifferent" || mode === "direction" ? simpleAnswer === correctSimple : mode === "complete" ? pitchClassAnswer === targetPc && octaveAnswer === targetOctave : mode === "octave" ? octaveAnswer === targetOctave : pitchClassAnswer === targetPc;

  return (
    <div className="page ear-page">
      <div className="lab-intro">
        <div><Eyebrow>Absolute labels stay separate</Eyebrow><h1>What did the sound keep?</h1><p>Pitch class, register, and complete note identity are measured independently. A right F♯ in the wrong octave is partial knowledge—not a total miss.</p></div>
        <div className="score-lozenges"><span><small>TRIALS</small><b>{score.attempts}</b></span><span><small>PITCH CLASS</small><b>{score.attempts ? Math.round(score.pitchClass / score.attempts * 100) : 0}%</b></span><span><small>OCTAVE</small><b>{score.attempts ? Math.round(score.octave / score.attempts * 100) : 0}%</b></span></div>
      </div>

      <Panel className="ear-config">
        <Segmented value={mode} onChange={setMode} options={modes} />
        <div className="ear-switches"><Switch label="Cross-timbre" checked={crossTimbre} onChange={setCrossTimbre} /><Switch label="Discovery mode" checked={labelsHidden} onChange={setLabelsHidden} /></div>
      </Panel>

      <div className="ear-workspace">
        <Panel className="ear-prompt-card">
          <div className="trial-index">TRIAL {String(score.attempts + 1).padStart(2, "0")} <span /> {mode.replace(/([A-Z])/g, " $1")}</div>
          <div className="sound-orb" onClick={playTrial} role="button" tabIndex={0} aria-label="Play prompt">
            <div className="orb-ring one" /><div className="orb-ring two" /><div className="orb-ring three" />
            <Icon name="play" size={32} /><span>PLAY SOUND</span>
          </div>
          <h2>{primaryPrompt}</h2>
          <p>{mode === "reference" ? "The first tone is always A4. The second travels." : crossTimbre ? `Timbres vary independently: ${trial.timbreA} → ${trial.timbreB}.` : "Both sounds use the same timbre."}</p>
          <PlayButton label="Replay prompt" onClick={playTrial} />
        </Panel>

        <Panel className="answer-card">
          <Eyebrow>Your reading</Eyebrow>
          {(mode === "sameDifferent" || mode === "direction") && <div className="binary-answers">
            {(mode === "sameDifferent" ? ["same", "different"] : ["higher", "lower"]).map((answer) => <button key={answer} className={`${simpleAnswer === answer ? "selected" : ""} ${submitted && answer === correctSimple ? "correct" : ""} ${submitted && simpleAnswer === answer && answer !== correctSimple ? "incorrect" : ""}`} onClick={() => !submitted && setSimpleAnswer(answer)}><span>{answer === "higher" ? "↗" : answer === "lower" ? "↘" : answer === "same" ? "＝" : "≠"}</span><b>{answer}</b></button>)}
          </div>}

          {!(mode === "sameDifferent" || mode === "direction") && <>
            {mode !== "octave" && <><div className="answer-label"><span>1</span><div><b>Pitch class</b><small>Identity, independent of octave</small></div>{submitted && <em className={pitchClassAnswer === targetPc ? "pass" : "miss"}>{pitchClassAnswer === targetPc ? "mapped" : "review"}</em>}</div>
            <div className="pitch-class-grid">{Array.from({ length: 12 }, (_, pc) => <button key={pc} disabled={submitted} className={`${pitchClassAnswer === pc ? "selected" : ""} ${submitted && pc === targetPc ? "correct" : ""} ${submitted && pitchClassAnswer === pc && pc !== targetPc ? "incorrect" : ""}`} onClick={() => setPitchClassAnswer(pc)}>{pitchClassLabel(pc)}</button>)}</div></>}
            {(mode === "complete" || mode === "octave") && <><div className={`answer-label ${mode === "complete" ? "second" : ""}`}><span>{mode === "complete" ? "2" : "1"}</span><div><b>Octave</b><small>Register, scored separately</small></div>{submitted && <em className={octaveAnswer === targetOctave ? "pass" : "miss"}>{octaveAnswer === targetOctave ? "mapped" : "review"}</em>}</div><div className="octave-grid">{[2, 3, 4, 5].map((octave) => <button key={octave} disabled={submitted} className={`${octaveAnswer === octave ? "selected" : ""} ${submitted && octave === targetOctave ? "correct" : ""} ${submitted && octaveAnswer === octave && octave !== targetOctave ? "incorrect" : ""}`} onClick={() => setOctaveAnswer(octave)}>Octave {octave}</button>)}</div></>}
          </>}

          {submitted && <div className={`answer-result ${resultCorrect ? "correct" : "partial"}`}><Icon name={resultCorrect ? "spark" : "ear"} size={21} /><div><span>{resultCorrect ? "Relationship mapped" : mode === "complete" && (pitchClassAnswer === targetPc || octaveAnswer === targetOctave) ? "One coordinate mapped" : "Useful confusion captured"}</span><b>{labelsHidden ? "Reveal: " : ""}{noteLabel(trial.targetMidi)} · {continuousMidiToHz(trial.targetMidi).toFixed(2)} Hz</b><small>{mode === "complete" && pitchClassAnswer === targetPc && octaveAnswer !== targetOctave ? "Pitch class succeeded; register needs another pass." : "This exact distinction updates its own skill node."}</small></div></div>}

          <ActionButton className="wide primary" disabled={!canSubmit} onClick={submitted ? next : submit}>{submitted ? <>Next sound <Icon name="arrow" size={17} /></> : "Commit answer"}</ActionButton>
        </Panel>
      </div>

      <Panel className="timbre-strip"><div><Eyebrow>Incidental clues are shuffled</Eyebrow><h3>One pitch · eight surfaces</h3></div><div>{TIMBRES.map((item) => <button key={item} onClick={() => playTone({ frequencyHz: continuousMidiToHz(trial.targetMidi), timbre: item, duration: .65 })}><span className={`timbre-wave wave-${item.replace(" ", "-")}`} />{item}</button>)}</div></Panel>
    </div>
  );
}
