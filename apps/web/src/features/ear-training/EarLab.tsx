import { useEffect, useState } from "react";
import { normalizePitchClass } from "@noteforge/music-core";
import { playSafely, playTone, playToneSequence, TIMBRES, type Timbre } from "@/audio/synth";
import { useLab } from "@/state/LabContext";
import { continuousMidiToHz, noteLabel, pitchClassLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel, PlayButton, Segmented, Select, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteFamilyTrainer, type FoundationEarMode } from "./NoteFamilyTrainer";

type AdvancedEarMode = "sameDifferent" | "direction" | "pitchClass" | "octave" | "complete" | "family";
type EarMode = FoundationEarMode | AdvancedEarMode;

const modes: { value: EarMode; label: string }[] = [
  { value: "letters", label: "Letters · fixed register" },
  { value: "reference", label: "Anchor + keyboard" },
  { value: "sameDifferent", label: "Same / different" },
  { value: "direction", label: "Higher / lower" },
  { value: "pitchClass", label: "Chromatic · mixed register" },
  { value: "octave", label: "Octave only" },
  { value: "complete", label: "Full note" },
  { value: "family", label: "Across octaves" }
];

interface Trial {
  firstMidi: number;
  targetMidi: number;
  timbreA: Timbre;
  timbreB: Timbre;
}

interface AdvancedScore {
  attempts: number;
  pitchClass: number;
  pitchClassAttempts: number;
  octave: number;
  octaveAttempts: number;
  relation: number;
  relationAttempts: number;
}

function isFoundationMode(mode: EarMode): mode is FoundationEarMode {
  return mode === "letters" || mode === "reference";
}

function randomTimbre(): Timbre {
  return TIMBRES[Math.floor(Math.random() * TIMBRES.length)] ?? "sine";
}

function newAdvancedTrial(mode: AdvancedEarMode, crossTimbre: boolean): Trial {
  const timbreA = randomTimbre();
  const timbreB = crossTimbre ? randomTimbre() : timbreA;
  const targetMidi = mode === "octave"
    ? 36 + Math.floor(Math.random() * 48)
    : 48 + Math.floor(Math.random() * 24);
  let firstMidi = 69;
  if (mode === "sameDifferent") {
    firstMidi = Math.random() < 0.45
      ? targetMidi
      : Math.max(45, Math.min(76, targetMidi + ([-5, -2, -1, 1, 2, 5][Math.floor(Math.random() * 6)] ?? 1)));
  }
  if (mode === "direction") {
    firstMidi = Math.max(45, Math.min(76, targetMidi + (Math.random() < 0.5 ? -(1 + Math.floor(Math.random() * 7)) : 1 + Math.floor(Math.random() * 7))));
  }
  return { firstMidi, targetMidi, timbreA, timbreB };
}

export function EarLab() {
  const { timbre, setTimbre, labelsHidden, setLabelsHidden, setSelectedMidi } = useLab();
  const [mode, setMode] = useState<EarMode>("letters");
  const [crossTimbre, setCrossTimbre] = useState(false);
  const [trial, setTrial] = useState(() => newAdvancedTrial("pitchClass", false));
  const [pitchClassAnswer, setPitchClassAnswer] = useState<number>();
  const [octaveAnswer, setOctaveAnswer] = useState<number>();
  const [simpleAnswer, setSimpleAnswer] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState<AdvancedScore>({
    attempts: 0,
    pitchClass: 0,
    pitchClassAttempts: 0,
    octave: 0,
    octaveAttempts: 0,
    relation: 0,
    relationAttempts: 0
  });

  useEffect(() => {
    if (isFoundationMode(mode)) return;
    setTrial(newAdvancedTrial(mode, crossTimbre));
    setPitchClassAnswer(undefined);
    setOctaveAnswer(undefined);
    setSimpleAnswer(undefined);
    setSubmitted(false);
  }, [mode, crossTimbre]);

  const targetPc = normalizePitchClass(trial.targetMidi);
  const targetOctave = Math.floor(trial.targetMidi / 12) - 1;
  const correctSimple = mode === "sameDifferent"
    ? (trial.firstMidi === trial.targetMidi ? "same" : "different")
    : trial.targetMidi > trial.firstMidi ? "higher" : "lower";

  const playTrial = () => {
    if (isFoundationMode(mode)) return;
    if (mode === "pitchClass" || mode === "octave" || mode === "complete") {
      playSafely(playTone({
        frequencyHz: continuousMidiToHz(trial.targetMidi),
        timbre: crossTimbre ? trial.timbreB : timbre,
        duration: 1.15
      }), "Ear-training tone");
      return;
    }
    if (mode === "family") {
      const notes = [36 + targetPc, 48 + targetPc, 60 + targetPc, 72 + targetPc].filter((midi) => midi >= 40 && midi <= 84);
      playSafely(playToneSequence(notes.map((midi, index) => ({
        frequencyHz: continuousMidiToHz(midi),
        timbre: crossTimbre ? (index % 2 ? trial.timbreB : trial.timbreA) : timbre,
        duration: 0.55,
        amplitude: 0.2
      })), { gap: 0.12 }), "Ear-training note family");
      return;
    }
    playSafely(playToneSequence([
      { frequencyHz: continuousMidiToHz(trial.firstMidi), timbre: crossTimbre ? trial.timbreA : timbre, duration: 0.72, amplitude: 0.24, gapAfter: 0.16 },
      { frequencyHz: continuousMidiToHz(trial.targetMidi), timbre: crossTimbre ? trial.timbreB : timbre, duration: 0.72, amplitude: 0.24 }
    ]), "Ear-training comparison");
  };

  const submit = () => {
    if (submitted || isFoundationMode(mode)) return;
    const pcCorrect = pitchClassAnswer === targetPc;
    const octaveCorrect = octaveAnswer === targetOctave;
    const simpleCorrect = simpleAnswer === correctSimple;
    const scoresPitchClass = mode === "pitchClass" || mode === "complete" || mode === "family";
    const scoresOctave = mode === "complete" || mode === "octave";
    const scoresRelation = mode === "sameDifferent" || mode === "direction";
    setScore((current) => ({
      attempts: current.attempts + 1,
      pitchClass: current.pitchClass + (scoresPitchClass && pcCorrect ? 1 : 0),
      pitchClassAttempts: current.pitchClassAttempts + (scoresPitchClass ? 1 : 0),
      octave: current.octave + (scoresOctave && octaveCorrect ? 1 : 0),
      octaveAttempts: current.octaveAttempts + (scoresOctave ? 1 : 0),
      relation: current.relation + (scoresRelation && simpleCorrect ? 1 : 0),
      relationAttempts: current.relationAttempts + (scoresRelation ? 1 : 0)
    }));
    setSubmitted(true);
    setSelectedMidi(trial.targetMidi);
  };

  const next = () => {
    if (isFoundationMode(mode)) return;
    setTrial(newAdvancedTrial(mode, crossTimbre));
    setPitchClassAnswer(undefined);
    setOctaveAnswer(undefined);
    setSimpleAnswer(undefined);
    setSubmitted(false);
  };

  const advancedMode = !isFoundationMode(mode);
  const canSubmit = advancedMode && (
    mode === "sameDifferent" || mode === "direction"
      ? simpleAnswer != null
      : mode === "complete"
        ? pitchClassAnswer != null && octaveAnswer != null
        : mode === "octave"
          ? octaveAnswer != null
          : pitchClassAnswer != null
  );
  const primaryPrompt = mode === "sameDifferent"
    ? "Did the pitch change?"
    : mode === "direction"
      ? "Where did the second sound move?"
      : mode === "family"
        ? "What remains constant across registers?"
        : mode === "octave"
          ? "Which register contains the sound?"
          : mode === "complete"
            ? "Name both identity and register."
            : "Name the chromatic pitch class across mixed registers.";
  const resultCorrect = advancedMode && (
    mode === "sameDifferent" || mode === "direction"
      ? simpleAnswer === correctSimple
      : mode === "complete"
        ? pitchClassAnswer === targetPc && octaveAnswer === targetOctave
        : mode === "octave"
          ? octaveAnswer === targetOctave
          : pitchClassAnswer === targetPc
  );

  return (
    <div className="page ear-page">
      <div className="lab-intro">
        <div>
          <Eyebrow>{isFoundationMode(mode) ? "Foundation · one variable at a time" : "Advanced recognition"}</Eyebrow>
          <h1>{mode === "letters" ? "Learn one register before anything moves." : mode === "reference" ? "Keep the start visible while you navigate." : "Separate identity, register, and relationship."}</h1>
          <p>{isFoundationMode(mode) ? "The active note family never changes octave mid-drill. Every letter earns visible evidence, and moving upward is always a decision—not a surprise." : "These drills intentionally vary more than one dimension. Return to fixed-register letters whenever register changes obscure the thing you are learning."}</p>
        </div>
        {advancedMode ? (
          <div className="score-lozenges">
            <span><small>TRIALS</small><b>{score.attempts}</b></span>
            <span><small>PITCH CLASS</small><b>{score.pitchClassAttempts ? Math.round(score.pitchClass / score.pitchClassAttempts * 100) : 0}%</b></span>
            <span><small>OCTAVE</small><b>{score.octaveAttempts ? Math.round(score.octave / score.octaveAttempts * 100) : 0}%</b></span>
          </div>
        ) : (
          <div className="register-principle"><small>CURRENT RULE</small><b>ONE C → B FAMILY</b><span>Manual progression only</span></div>
        )}
      </div>

      <Panel className="ear-config">
        <Segmented label="Recognition drill" value={mode} onChange={setMode} options={modes} />
        <div className="ear-tools">
          <Select label="Timbre" value={timbre} onChange={(event) => setTimbre(event.target.value as Timbre)}>
            {TIMBRES.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
          <Switch label="Vary timbre (advanced)" checked={crossTimbre} onChange={setCrossTimbre} />
          {advancedMode && <Switch label="Discovery mode" checked={labelsHidden} onChange={setLabelsHidden} />}
        </div>
      </Panel>

      {isFoundationMode(mode) ? (
        <NoteFamilyTrainer mode={mode} timbre={timbre} varyTimbre={crossTimbre} onRevealMidi={setSelectedMidi} />
      ) : (
        <>
          <Panel className="advanced-warning">
            <Icon name="spark" size={17} />
            <span><b>Advanced variation is intentional here.</b> Mixed register and chromatic material are isolated from your fixed-family mastery.</span>
          </Panel>

          <div className="ear-workspace">
            <Panel className="ear-prompt-card">
              <div className="trial-index">TRIAL {String(score.attempts + 1).padStart(2, "0")} <span /> {mode.replace(/([A-Z])/g, " $1")}</div>
              <button className="sound-orb" type="button" onClick={playTrial} aria-label="Play prompt">
                <div className="orb-ring one" /><div className="orb-ring two" /><div className="orb-ring three" />
                <Icon name="play" size={32} /><span>PLAY SOUND</span>
              </button>
              <h2>{primaryPrompt}</h2>
              <p>{crossTimbre ? `Timbres vary independently: ${trial.timbreA} → ${trial.timbreB}.` : `Every sound uses the selected ${timbre} timbre.`}</p>
              <PlayButton label="Replay prompt" onClick={playTrial} />
            </Panel>

            <Panel className="answer-card">
              <Eyebrow>Your reading</Eyebrow>
              {(mode === "sameDifferent" || mode === "direction") && (
                <div className="binary-answers">
                  {(mode === "sameDifferent" ? ["same", "different"] : ["higher", "lower"]).map((answer) => (
                    <button
                      key={answer}
                      type="button"
                      className={`${simpleAnswer === answer ? "selected" : ""} ${submitted && answer === correctSimple ? "correct" : ""} ${submitted && simpleAnswer === answer && answer !== correctSimple ? "incorrect" : ""}`}
                      onClick={() => !submitted && setSimpleAnswer(answer)}
                    >
                      <span>{answer === "higher" ? "↗" : answer === "lower" ? "↘" : answer === "same" ? "＝" : "≠"}</span><b>{answer}</b>
                    </button>
                  ))}
                </div>
              )}

              {!(mode === "sameDifferent" || mode === "direction") && (
                <>
                  {mode !== "octave" && (
                    <>
                      <div className="answer-label"><span>1</span><div><b>Pitch class</b><small>Identity, independent of octave</small></div>{submitted && <em className={pitchClassAnswer === targetPc ? "pass" : "miss"}>{pitchClassAnswer === targetPc ? "mapped" : "review"}</em>}</div>
                      <div className="pitch-class-grid">{Array.from({ length: 12 }, (_, pc) => <button key={pc} type="button" disabled={submitted} className={`${pitchClassAnswer === pc ? "selected" : ""} ${submitted && pc === targetPc ? "correct" : ""} ${submitted && pitchClassAnswer === pc && pc !== targetPc ? "incorrect" : ""}`} onClick={() => setPitchClassAnswer(pc)}>{pitchClassLabel(pc)}</button>)}</div>
                    </>
                  )}
                  {(mode === "complete" || mode === "octave") && (
                    <>
                      <div className={`answer-label ${mode === "complete" ? "second" : ""}`}><span>{mode === "complete" ? "2" : "1"}</span><div><b>Octave</b><small>Register, scored separately</small></div>{submitted && <em className={octaveAnswer === targetOctave ? "pass" : "miss"}>{octaveAnswer === targetOctave ? "mapped" : "review"}</em>}</div>
                      <div className="octave-grid">{[2, 3, 4, 5].map((octave) => <button key={octave} type="button" disabled={submitted} className={`${octaveAnswer === octave ? "selected" : ""} ${submitted && octave === targetOctave ? "correct" : ""} ${submitted && octaveAnswer === octave && octave !== targetOctave ? "incorrect" : ""}`} onClick={() => setOctaveAnswer(octave)}>Octave {octave}</button>)}</div>
                    </>
                  )}
                </>
              )}

              {submitted && (
                <div className={`answer-result ${resultCorrect ? "correct" : "partial"}`}>
                  <Icon name={resultCorrect ? "spark" : "ear"} size={21} />
                  <div><span>{resultCorrect ? "Relationship mapped" : mode === "complete" && (pitchClassAnswer === targetPc || octaveAnswer === targetOctave) ? "One coordinate mapped" : "Useful confusion captured"}</span><b>{labelsHidden ? "Reveal: " : ""}{noteLabel(trial.targetMidi)} · {continuousMidiToHz(trial.targetMidi).toFixed(2)} Hz</b><small>{mode === "complete" && pitchClassAnswer === targetPc && octaveAnswer !== targetOctave ? "Pitch class succeeded; register needs another pass." : "This distinction stays separate from fixed-family progress."}</small></div>
                </div>
              )}

              <ActionButton className="wide primary" disabled={!canSubmit} onClick={submitted ? next : submit}>{submitted ? <>Next sound <Icon name="arrow" size={17} /></> : "Commit answer"}</ActionButton>
            </Panel>
          </div>

          <Panel className="timbre-strip"><div><Eyebrow>Incidental clues can be challenged deliberately</Eyebrow><h3>One pitch · eight surfaces</h3></div><div>{TIMBRES.map((item) => <button type="button" key={item} onClick={() => playSafely(playTone({ frequencyHz: continuousMidiToHz(trial.targetMidi), timbre: item, duration: .65 }), `${item} timbre example`)}><span className={`timbre-wave wave-${item.replace(" ", "-")}`} />{item}</button>)}</div></Panel>
        </>
      )}
    </div>
  );
}
