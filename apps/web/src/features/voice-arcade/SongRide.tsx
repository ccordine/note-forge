import type { CSSProperties } from "react";
import {
  MAX_LOCAL_AUDIO_DURATION_SECONDS,
  MAX_LOCAL_AUDIO_FILE_BYTES,
  MIN_LOCAL_AUDIO_DURATION_SECONDS,
  formatFileSize,
} from "@/audio/local-audio-file";
import { noteLabel, signed } from "@/lib/music-display";
import { ActionButton, Eyebrow, Panel } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";
import { resolveArcadeCurriculum } from "./curriculum";
import type { SongTargetLane } from "./song-lane-types";
import { songLaneAtTime, type SongRideSession } from "./song-ride-session";
import type { ArcadeFeedbackPolicy, ArcadeGameProps } from "./types";
import { formatSongTime, useSongRide, type SongRideController } from "./use-song-ride";

const AUDIO_ACCEPT = "audio/*,.mp3,.m4a,.wav,.ogg,.flac";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

interface LiveSongView {
  readonly activeLane: SongTargetLane | null;
  readonly nextLane: SongTargetLane | null;
  readonly liveMidi: number | null;
  readonly liveErrorCents: number | null;
  readonly voiceLocked: boolean;
  readonly liveTop: number;
  readonly visibleLanes: readonly Readonly<{
    lane: SongTargetLane;
    left: number;
    width: number;
    top: number;
  }>[];
  readonly remainingSeconds: number;
  readonly progressPercent: number;
}

function createLiveSongView(
  session: Readonly<SongRideSession>,
  props: Pick<ArcadeGameProps, "difficulty" | "voiceRange">,
): LiveSongView {
  const { analysis, currentTime } = session;
  const activeLane = analysis && session.playbackState !== "ended"
    ? songLaneAtTime(analysis.lanes, currentTime)
    : null;
  const activeIndex = activeLane && analysis ? analysis.lanes.indexOf(activeLane) : -1;
  const nextLane = analysis
    ? activeIndex >= 0
      ? analysis.lanes[activeIndex + 1] ?? null
      : analysis.lanes.find((lane) => lane.startSeconds > currentTime) ?? null
    : null;
  const frame = session.liveObservation;
  const liveMidi = frame?.voiced && frame.midiFloat !== null ? frame.midiFloat : null;
  const liveErrorCents = liveMidi === null || !activeLane
    ? null
    : (liveMidi - activeLane.targetMidi) * 100;
  const voiceLocked = liveErrorCents !== null
    && Math.abs(liveErrorCents) <= activeLane!.toleranceCents;
  const rangeSpan = Math.max(1, props.voiceRange.highMidi - props.voiceRange.lowMidi);
  const pitchTop = (midi: number) => 8 + (
    1 - clamp((midi - props.voiceRange.lowMidi) / rangeSpan, 0, 1)
  ) * 84;
  const lookAheadSeconds = props.difficulty === "hard"
    ? 6
    : props.difficulty === "medium" ? 7.5 : 9;
  const visibleLanes = analysis?.lanes
    .filter((lane) => lane.endSeconds >= currentTime - 0.5
      && lane.startSeconds <= currentTime + lookAheadSeconds)
    .map((lane) => ({
      lane,
      left: 14 + (lane.startSeconds - currentTime) / lookAheadSeconds * 82,
      width: Math.max(1.5, lane.durationSeconds / lookAheadSeconds * 82),
      top: pitchTop(lane.targetMidi),
    })) ?? [];
  const duration = analysis?.durationSeconds ?? 0;
  return {
    activeLane,
    nextLane,
    liveMidi,
    liveErrorCents,
    voiceLocked,
    liveTop: liveMidi === null ? 50 : pitchTop(liveMidi),
    visibleLanes,
    remainingSeconds: Math.max(0, duration - currentTime),
    progressPercent: duration === 0 ? 0 : clamp(currentTime / duration * 100, 0, 100),
  };
}

function FilePicker({ label, onFile }: {
  readonly label: string;
  readonly onFile: (file: File) => void;
}) {
  return (
    <label className="song-upload-drop">
      <Icon name="song" size={30} />
      <span><b>{label}</b><small>Decoded and analyzed in memory · never uploaded</small></span>
      <input
        type="file"
        accept={AUDIO_ACCEPT}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

function SongRideHud({ controller, onExit }: {
  readonly controller: Readonly<SongRideController>;
  readonly onExit: () => void;
}) {
  const { session, input } = controller;
  const running = session.phase === "playing";
  return (
    <>
      <div className="arcade-game-hud song-ride-hud">
        <div><span>TRACK</span><strong>{session.analysis ? formatSongTime(session.analysis.durationSeconds) : "LOCAL"}</strong></div>
        <div><span>SCORE</span><strong>{session.hud.score}</strong></div>
        <div className="combo"><span>COMBO</span><strong>{session.hud.combo}<small>×</small></strong></div>
        <div><span>IN LANE</span><strong>{session.hud.accuracyPercent.toFixed(0)}%</strong></div>
        <ActionButton
          className={running ? "coral" : ""}
          onClick={running ? controller.finish : onExit}
        >
          <Icon name={running ? "pause" : "arrow"} size={16} />
          {running ? "Stop & grade" : "Exit game"}
        </ActionButton>
      </div>
      <div className="song-live-note"><NoteInput variant="compact" input={input} compact /></div>
    </>
  );
}

function UploadStage({ controller, stageLabel, stageSummary, voiceRange }: {
  readonly controller: Readonly<SongRideController>;
  readonly stageLabel: string;
  readonly stageSummary: string;
  readonly voiceRange: ArcadeGameProps["voiceRange"];
}) {
  return (
    <Panel className="arcade-game-loadout song-ride-upload">
      <div>
        <Eyebrow>Song Rail · {stageLabel}</Eyebrow>
        <h1>Turn a track into a voice-controlled rail.</h1>
        <p>NoteForge derives a timed dominant-pitch contour locally and fits it to your voice range. {stageSummary}</p>
      </div>
      <FilePicker label="Choose MP3 or audio" onFile={(file) => { void controller.loadFile(file); }} />
      <div className="song-analysis-contract">
        <span><b>≤ {formatFileSize(MAX_LOCAL_AUDIO_FILE_BYTES)}</b><small>file guard</small></span>
        <span><b>{formatSongTime(MIN_LOCAL_AUDIO_DURATION_SECONDS)}–{formatSongTime(MAX_LOCAL_AUDIO_DURATION_SECONDS)}</b><small>duration guard</small></span>
        <span><b>{noteLabel(voiceRange.lowMidi)}–{noteLabel(voiceRange.highMidi)}</b><small>fitted targets</small></span>
      </div>
      <p className="song-chart-disclosure"><Icon name="spark" size={18} /><span><b>A generated challenge, not stem separation.</b> Dense mixes can follow accompaniment or harmonics. Clear single-line passages produce the best rail.</span></p>
      {controller.session.error && <div className="error-banner" role="alert">{controller.session.error}</div>}
    </Panel>
  );
}

function AnalysisStage({ status }: { readonly status: string }) {
  return (
    <Panel className="arcade-countdown-stage song-analyzing-stage" aria-live="polite">
      <span className="arcade-countdown-orb"><Icon name="song" size={34} /></span>
      <Eyebrow>On-device chart generation</Eyebrow>
      <h2>Analyzing the track…</h2>
      <p>{status}</p>
      <small>The file and decoded samples remain inside this browser tab.</small>
    </Panel>
  );
}

function ReadyStage({ controller, feedback }: {
  readonly controller: Readonly<SongRideController>;
  readonly feedback: Readonly<ArcadeFeedbackPolicy>;
}) {
  const { session } = controller;
  const { track, analysis } = session;
  if (!track || !analysis) return null;
  return (
    <Panel className="arcade-game-loadout song-ready-stage">
      <div className="song-file-meta">
        <span className="song-file-icon"><Icon name="song" size={28} /></span>
        <div><small>LOCAL CHALLENGE READY</small><h2>{track.name}</h2><p>{formatSongTime(analysis.durationSeconds)} · {formatFileSize(track.sizeBytes)} · {analysis.lanes.length.toLocaleString()} lanes</p></div>
      </div>
      <div className="arcade-contract-grid song-ready-contract">
        <span><b>{feedback.showCents ? `±${analysis.toleranceCents}¢` : "SET"}</b><small>lane width</small></span>
        <span><b>{signed(analysis.transposeSemitones)}</b><small>semitones fitted</small></span>
        <span><b>{analysis.clippedLaneCount}</b><small>range-clipped lanes</small></span>
      </div>
      <p className="song-chart-disclosure"><Icon name="headphones" size={18} /><span><b>Headphones are recommended, never required.</b> Track playback and microphone telemetry both remain continuous; open speakers can naturally enter the microphone signal.</span></p>
      <p className="song-ready-status" role="status">{session.status}</p>
      {session.error && <div className="error-banner" role="alert">{session.error}</div>}
      <div className="arcade-start-row">
        <FilePicker label="Replace track" onFile={(file) => { void controller.loadFile(file); }} />
        <ActionButton onClick={controller.clearTrack}>Clear track</ActionButton>
        <ActionButton
          className="primary"
          onClick={() => { void controller.start(); }}
        >Start Song Rail <Icon name="arrow" size={18} /></ActionButton>
      </div>
    </Panel>
  );
}

function liveVoiceCopy(view: Readonly<LiveSongView>, feedback: Readonly<ArcadeFeedbackPolicy>): {
  label: string;
  detail: string;
} {
  if (view.liveMidi === null) return { label: "—", detail: "current window unvoiced" };
  const label = feedback.showLiveNote ? noteLabel(view.liveMidi) : "TRACKING";
  if (view.liveErrorCents === null) return { label, detail: "breathing gap" };
  if (!feedback.showCents) {
    return {
      label,
      detail: view.liveErrorCents < 0 ? "move up" : view.liveErrorCents > 0 ? "move down" : "centered",
    };
  }
  return {
    label,
    detail: `${signed(view.liveErrorCents, 0)}¢ · ${view.liveErrorCents < 0 ? "move up" : view.liveErrorCents > 0 ? "move down" : "centered"}`,
  };
}

function upcomingLaneLabel(
  view: Readonly<LiveSongView>,
  feedback: Readonly<ArcadeFeedbackPolicy>,
): string {
  if (view.nextLane === null) return "END";
  return feedback.showUpcomingCue ? noteLabel(view.nextLane.targetMidi) : "HIDDEN";
}

function songLaneClass(
  lane: Readonly<SongTargetLane>,
  activeLane: Readonly<SongTargetLane> | null,
  currentTime: number,
): string {
  if (lane.id === activeLane?.id) return "song-rail-lane active";
  return lane.endSeconds < currentTime ? "song-rail-lane past" : "song-rail-lane future";
}

function PlayStage({ controller, view, feedback, voiceRange }: {
  readonly controller: Readonly<SongRideController>;
  readonly view: Readonly<LiveSongView>;
  readonly feedback: Readonly<ArcadeFeedbackPolicy>;
  readonly voiceRange: ArcadeGameProps["voiceRange"];
}) {
  const { session } = controller;
  const paused = session.playbackState === "paused";
  const ended = session.playbackState === "ended";
  const voice = liveVoiceCopy(view, feedback);
  const nextLabel = upcomingLaneLabel(view, feedback);
  let playbackLabel = "Pause track";
  let playbackIcon: "pause" | "play" | "loop" = "pause";
  let playbackAction: () => void = controller.pausePlayback;
  if (paused) {
    playbackLabel = "Continue track";
    playbackIcon = "play";
    playbackAction = () => { void controller.resumePlayback(); };
  }
  if (ended) {
    playbackLabel = "Replay track";
    playbackIcon = "loop";
    playbackAction = () => { void controller.replay(); };
  }
  return (
    <div
      className={`song-ride-stage playback-${session.playbackState}`}
      data-live-lifetime="user-owned"
      data-song-playback={session.playbackState}
    >
      <div className="song-ride-readout">
        <div><span>NOW</span><strong>{view.activeLane ? noteLabel(view.activeLane.targetMidi) : "BREATHE"}</strong><small>{view.activeLane ? `±${view.activeLane.toleranceCents}¢ lane` : "next target incoming"}</small></div>
        <div className={view.voiceLocked ? "locked" : ""}><span>YOUR VOICE</span><strong>{voice.label}</strong><small>{voice.detail}</small></div>
        <div><span>NEXT</span><strong>{nextLabel}</strong><small>{formatSongTime(view.remainingSeconds)} remaining</small></div>
      </div>
      <div className="song-rail" role="img" aria-label={view.activeLane ? `Current target ${noteLabel(view.activeLane.targetMidi)}.` : "Breathing gap."}>
        <div className="song-rail-grid">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
        <i className="song-rail-playhead"><span>NOW</span></i>
        {view.visibleLanes.map(({ lane, left, width, top }) => (
          <span
            key={lane.id}
            className={songLaneClass(lane, view.activeLane, session.currentTime)}
            style={{ "--lane-left": `${left}%`, "--lane-width": `${width}%`, "--lane-top": `${top}%` } as CSSProperties}
          ><b>{feedback.showUpcomingCue || lane.id === view.activeLane?.id || lane.endSeconds < session.currentTime ? noteLabel(lane.targetMidi) : "•"}</b></span>
        ))}
        <span
          className={`song-voice-cursor ${view.liveMidi === null ? "silent" : ""} ${view.voiceLocked ? "locked" : ""}`}
          style={{ "--voice-top": `${view.liveTop}%` } as CSSProperties}
          role="meter"
          aria-label="Live voice pitch position"
          aria-valuemin={voiceRange.lowMidi}
          aria-valuemax={voiceRange.highMidi}
          aria-valuenow={view.liveMidi ?? undefined}
          aria-valuetext={view.liveMidi === null ? "No reliable pitch" : noteLabel(view.liveMidi)}
        ><i />{feedback.showLiveNote && <b>{view.liveMidi === null ? "VOICE" : noteLabel(view.liveMidi)}</b>}</span>
      </div>
      <div className="song-transport">
        <button type="button" onClick={playbackAction}><Icon name={playbackIcon} size={18} /> {playbackLabel}</button>
        <div><span>{formatSongTime(session.currentTime)}</span><div className="song-progress-track" role="progressbar" aria-label="Song progress" aria-valuemin={0} aria-valuemax={Math.max(1, session.analysis?.durationSeconds ?? 1)} aria-valuenow={session.currentTime}><i style={{ width: `${view.progressPercent}%` }} /></div><span>−{formatSongTime(view.remainingSeconds)}</span></div>
        <button type="button" className="coral" onClick={controller.finish}>Stop & grade</button>
      </div>
      {ended && session.result && (
        <div className="song-ride-status song-track-achievement" role="status">
          <span><b>Track complete · {session.result.grade}</b> {session.result.score}/100. Replay is separate; your live voice control is still active.</span>
          <b>{session.result.hitLanes}/{session.result.attemptedLanes} lanes earned</b>
        </div>
      )}
      <div className="song-ride-status" role="status" aria-live="polite"><span>{session.status}</span><b>{view.activeLane ? `${session.hud.hitLanes}/${session.hud.attemptedLanes} lanes earned` : "Breathe · stay ready"}</b></div>
      {session.error && <div className="error-banner" role="alert">{session.error}</div>}
    </div>
  );
}

function ResultStage({ controller, onExit }: {
  readonly controller: Readonly<SongRideController>;
  readonly onExit: () => void;
}) {
  const result = controller.session.result;
  if (!result) return null;
  return (
    <Panel className="arcade-result-stage song-result-stage">
      <div className="arcade-result-grade"><span>SONG RAIL GRADE</span><strong>{result.grade}</strong><b>{result.score}<small>/100</small></b></div>
      <div className="arcade-result-copy">
        <Eyebrow>{result.completionPercent >= 99.5 ? "Track complete" : "Section graded"}</Eyebrow>
        <h2>{result.gradeLabel}</h2>
        <p>{controller.session.status}</p>
        <div className="arcade-result-metrics">
          <span><small>Lanes earned</small><b>{result.hitLanes}/{result.attemptedLanes}</b></span>
          <span><small>Time in lane</small><b>{result.accuracyPercent.toFixed(0)}%</b></span>
          <span><small>Best combo</small><b>{result.bestCombo}×</b></span>
          <span><small>Voiced coverage</small><b>{result.voicedCoveragePercent.toFixed(0)}%</b></span>
        </div>
        <div className="arcade-result-actions">
          <ActionButton onClick={onExit}>Back to cabinet</ActionButton>
          <ActionButton onClick={controller.clearTrack}>Choose another track</ActionButton>
          <ActionButton className="primary" onClick={() => { void controller.start(); }}>Start rail again <Icon name="arrow" size={16} /></ActionButton>
        </div>
      </div>
    </Panel>
  );
}

export function SongRide(props: ArcadeGameProps) {
  const controller = useSongRide(props);
  const curriculum = resolveArcadeCurriculum("song", props.curriculumStage);
  const view = createLiveSongView(controller.session, props);
  const { phase, track, status } = controller.session;
  return (
    <section className={`arcade-game-shell song-ride-shell curriculum-${curriculum.stage}`} data-song-phase={phase}>
      <audio
        ref={controller.audioRef}
        src={track?.url}
        preload="auto"
        onTimeUpdate={controller.syncProgress}
        onEnded={controller.completeTrack}
      />
      <SongRideHud controller={controller} onExit={props.onExit} />
      {phase === "upload" && <UploadStage controller={controller} stageLabel={curriculum.stageLabel} stageSummary={curriculum.stageSummary} voiceRange={props.voiceRange} />}
      {phase === "analyzing" && <AnalysisStage status={status} />}
      {phase === "ready" && <ReadyStage controller={controller} feedback={curriculum.feedback} />}
      {phase === "playing" && <PlayStage controller={controller} view={view} feedback={curriculum.feedback} voiceRange={props.voiceRange} />}
      {phase === "result" && <ResultStage controller={controller} onExit={props.onExit} />}
    </section>
  );
}
