import { noteLabel } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import type { ArcadeGameProps } from "./types";
import { usePitchPongRuntime } from "./use-pitch-pong";

export function PitchPong(props: ArcadeGameProps) {
  const { curriculumStage, onExit, voiceRange } = props;
  const runtime = usePitchPongRuntime(props);
  const {
    cancelBeforePlay, controllerCenterMidi, countdown, courtVariables, currentGame,
    curriculum, endActiveRound, input, maximumRally, maximumRallyPercent, pauseGame,
    phase, preset, rangeLabels, resetToSetup, result, resumeGame, scoreFlash,
    startRound, status,
  } = runtime;
  const rangeLabelClass = (index: number) => {
    if (index === 0) return "pong-range-label pong-range-high";
    if (index === rangeLabels.length - 1) return "pong-range-label pong-range-low";
    return "pong-range-label";
  };

  return (
    <section className={`arcade-game-shell pitch-pong-shell curriculum-${curriculumStage}`}>
      <div className="arcade-game-hud">
        <div className="pong-hud-score">
          <span>YOU</span><strong>{currentGame.playerScore}</strong><i>:</i><strong>{currentGame.opponentScore}</strong><span>CPU</span>
        </div>
        <div><span>RALLY</span><strong>{currentGame.rally}<small>×</small></strong></div>
        <div className="pong-hud-pitch"><NoteInput variant="compact" input={input} compact /></div>
        <div><span>FIRST TO</span><strong>{currentGame.config.winningScore}</strong></div>
        <div className="arcade-game-hud-actions">
          {phase === "playing" && <ActionButton onClick={() => pauseGame()}><Icon name="pause" size={16} /> Pause</ActionButton>}
          {(phase === "playing" || phase === "paused") && <ActionButton className="coral" onClick={endActiveRound}>Stop & grade</ActionButton>}
          {phase === "countdown" && <ActionButton onClick={cancelBeforePlay}>Cancel</ActionButton>}
          {(phase === "setup" || phase === "result") && <ActionButton onClick={onExit}><Icon name="arrow" size={16} /> Exit game</ActionButton>}
        </div>
      </div>

      {phase === "setup" && (
        <Panel className="arcade-game-loadout pong-game-loadout">
          <div>
            <Eyebrow>{curriculum.stageLabel} · Pitch Pong</Eyebrow>
            <h1>Your pitch is the paddle.</h1>
            <p>{curriculum.focus} Glide higher to rise and lower to drop. Silence freezes the paddle, so take real breaths instead of forcing nonstop sound.</p>
          </div>
          <div className="arcade-contract-grid">
            <span><b>{noteLabel(voiceRange.lowMidi)}–{noteLabel(voiceRange.highMidi)}</b><small>voice controller</small></span>
            <span><b>{noteLabel(controllerCenterMidi)}</b><small>center pitch</small></span>
            <span><b>{currentGame.config.winningScore}</b><small>points to win</small></span>
            <span><b>{preset.speedMultiplier.toFixed(2)}×</b><small>ball pace</small></span>
          </div>
          <div className="pong-instruction-strip">
            <span><i>↑</i><b>Sing higher</b><small>paddle rises</small></span>
            <span><i>↓</i><b>Sing lower</b><small>paddle drops</small></span>
            <span><i>◇</i><b>Go silent</b><small>paddle freezes</small></span>
          </div>
          {input.error && <div className="error-banner" role="alert">{input.error}</div>}
          <div className="arcade-start-row">
            <span>{status}</span>
            <ActionButton className="primary" onClick={startRound}>
              Start pitch match <Icon name="arrow" size={18} />
            </ActionButton>
          </div>
        </Panel>
      )}

      {phase === "countdown" && (
        <Panel className="arcade-countdown-stage">
          <span className="arcade-countdown-orb">{countdown}</span>
          <Eyebrow>Center your voice</Eyebrow>
          <h2 aria-live="polite" aria-atomic="true">{countdown === 0 ? "GO" : noteLabel(controllerCenterMidi)}</h2>
          <p>{status}</p>
          <ActionButton onClick={cancelBeforePlay}>Cancel match</ActionButton>
        </Panel>
      )}

      {(phase === "playing" || phase === "paused") && (
        <div className={`pong-play-stage ${phase === "paused" ? "is-paused" : ""}`}>
          <div
            className={`pong-court ${scoreFlash ? `score-${scoreFlash}` : ""}`}
            style={courtVariables}
            role="img"
            aria-label={`Pitch Pong court. You ${currentGame.playerScore}, computer ${currentGame.opponentScore}. Current rally ${currentGame.rally}.`}
          >
            <div className="pong-court-grid" aria-hidden="true" />
            <div className="pong-net" aria-hidden="true" />
            {rangeLabels.map((midi, index) => (
              <span className={rangeLabelClass(index)} key={`${midi}-${index}`}>{noteLabel(midi)}</span>
            ))}
            <span className="pong-paddle pong-player" aria-hidden="true" />
            <span className="pong-paddle pong-opponent" aria-hidden="true" />
            <span className="pong-ball-trail" aria-hidden="true" />
            <span className="pong-ball" aria-hidden="true" />
            {scoreFlash && <strong className="pong-score-flash" aria-live="polite">{scoreFlash === "player" ? "POINT" : "MISSED"}</strong>}

            {phase === "paused" && (
              <Panel className="pong-pause-overlay" role="dialog" aria-modal="false" aria-labelledby="pong-paused-title">
                <Icon name="pause" size={30} />
                <Eyebrow>Everything is frozen</Eyebrow>
                <h2 id="pong-paused-title">Match paused</h2>
                <p>{status}</p>
                <div>
                  <ActionButton className="primary" onClick={resumeGame}><Icon name="play" size={16} /> Resume</ActionButton>
                  <ActionButton className="coral" onClick={endActiveRound}>End & grade</ActionButton>
                </div>
              </Panel>
            )}
          </div>

          <div className="pong-live-footer">
            <span>{status}</span>
            <div className="pong-rally-meter"><small>LONGEST RALLY</small><b>{maximumRally}×</b><i><span style={{ width: `${maximumRallyPercent}%` }} /></i></div>
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <Panel className="arcade-result-stage pong-result-stage">
          <div className="arcade-result-grade">
            <span>CONTROL GRADE</span><strong>{result.grade}</strong><b>{result.scorePercent}<small>/100</small></b>
          </div>
          <div className="arcade-result-copy">
            <Eyebrow>{result.winner === "player" ? "Pitch match won" : "Pitch match complete"}</Eyebrow>
            <h2>{result.gradeLabel}</h2>
            <p>{status} Breathing time was neutral; only demonstrated steering and actual ball exchanges shaped this grade.</p>
            <div className="arcade-result-metrics">
              <span><small>Returns made</small><b>{result.playerReturns}/{result.incomingShots || "—"}</b></span>
              <span><small>Return rate</small><b>{result.returnRatePercent.toFixed(0)}%</b></span>
              <span><small>Longest rally</small><b>{result.maximumRally}×</b></span>
              <span><small>Match score</small><b>{result.playerScore}–{result.opponentScore}</b></span>
              <span><small>Range explored</small><b>{result.rangeCoveragePercent.toFixed(0)}%</b></span>
              <span><small>Observed notes</small><b>{result.lowestPitchMidi === null || result.highestPitchMidi === null ? "—" : `${noteLabel(result.lowestPitchMidi)}–${noteLabel(result.highestPitchMidi)}`}</b></span>
            </div>
            <div className="arcade-result-actions">
              <ActionButton onClick={onExit}>Back to cabinet</ActionButton>
              <ActionButton className="primary" onClick={resetToSetup}>Play another match <Icon name="arrow" size={16} /></ActionButton>
            </div>
          </div>
        </Panel>
      )}
    </section>
  );
}
