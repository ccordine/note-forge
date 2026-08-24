import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { decodeAudioFile } from "@/audio/audio-context";
import {
  MAX_LOCAL_AUDIO_DURATION_SECONDS,
  MAX_LOCAL_AUDIO_FILE_BYTES,
  formatFileSize,
  validateDecodedLocalAudio,
  validateLocalAudioFile,
} from "@/audio/local-audio-file";
import { useAudioInput } from "@/audio/use-audio-input";
import { pitchClassLabel } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { ActionButton, Eyebrow, Panel, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { NoteInput } from "@/ui/voice";

type PracticePass = "shadow" | "understand" | "mutate";

interface VoiceTake { id: string; url: string; createdAt: Date; }

const MAX_MARKERS = 200;
const MAX_PHRASE_TEXT_LENGTH = 500;
const MEDIA_RECORDER_TIMESLICE_MS = 1_000;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export function SongLab() {
  const { tonicPitchClass, setTonicPitchClass } = useLab();
  const [audioUrl, setAudioUrl] = useState<string>();
  const input = useAudioInput();
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);
  const [speed, setSpeed] = useState(.85);
  const [transpose, setTranspose] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [practicePass, setPracticePass] = useState<PracticePass>("shadow");
  const [chords, setChords] = useState("C | Am | F | G");
  const [phraseNote, setPhraseNote] = useState("");
  const [markers, setMarkers] = useState<{ time: number; type: "breath" | "phrase" }[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingStarting, setRecordingStarting] = useState(false);
  const [takes, setTakes] = useState<VoiceTake[]>([]);
  const [recordError, setRecordError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const mounted = useRef(false);
  const audioUrlRef = useRef<string | undefined>(undefined);
  const takesRef = useRef<VoiceTake[]>([]);
  const managedObjectUrls = useRef(new Set<string>());
  const loadGeneration = useRef(0);
  const playbackGeneration = useRef(0);
  const playbackDesired = useRef(false);
  const recordingGeneration = useRef(0);
  const recordingStopTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current += 1;
      playbackGeneration.current += 1;
      playbackDesired.current = false;
      recordingGeneration.current += 1;
      if (recordingStopTimer.current !== undefined) window.clearTimeout(recordingStopTimer.current);
      recordingStopTimer.current = undefined;
      const activeRecorder = recorder.current;
      recorder.current = undefined;
      if (activeRecorder && activeRecorder.state !== "inactive") {
        activeRecorder.ondataavailable = null;
        activeRecorder.onstop = null;
        try { activeRecorder.stop(); } catch { /* The recorder may have stopped between the state check and cleanup. */ }
      }
      managedObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      managedObjectUrls.current.clear();
      audioUrlRef.current = undefined;
      takesRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!audio.current) return;
    audio.current.playbackRate = speed * 2 ** (transpose / 12);
    audio.current.preservesPitch = transpose === 0;
  }, [speed, transpose]);

  const clearTakes = () => {
    takesRef.current.forEach((take) => {
      URL.revokeObjectURL(take.url);
      managedObjectUrls.current.delete(take.url);
    });
    takesRef.current = [];
    setTakes([]);
  };

  const stopPlayback = () => {
    playbackGeneration.current += 1;
    playbackDesired.current = false;
    audio.current?.pause();
    setPlaying(false);
  };

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      validateLocalAudioFile(file);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Choose a browser-decodable audio file.");
      return;
    }
    if (recording || recordingStarting || recorder.current) {
      setLoadError("Stop the current voice take before replacing its source track.");
      return;
    }
    const generation = ++loadGeneration.current;
    setLoadingFile(true);
    setLoadError("");
    try {
      const buffer = await file.arrayBuffer();
      if (!mounted.current || generation !== loadGeneration.current) return;
      const decoded = await decodeAudioFile(buffer);
      if (!mounted.current || generation !== loadGeneration.current) return;
      validateDecodedLocalAudio(decoded);
      const channel = decoded.getChannelData(0);
      const bins = 240;
      const bucket = Math.max(1, Math.floor(channel.length / bins));
      const nextPeaks = Array.from({ length: bins }, (_, index) => {
        let peak = 0;
        for (let sample = index * bucket; sample < Math.min(channel.length, (index + 1) * bucket); sample += 8) peak = Math.max(peak, Math.abs(channel[sample]));
        return peak;
      });
      const max = Math.max(...nextPeaks, .001);
      const normalizedPeaks = nextPeaks.map((peak) => peak / max);
      if (!mounted.current || generation !== loadGeneration.current) return;

      const url = URL.createObjectURL(file);
      managedObjectUrls.current.add(url);
      const previousUrl = audioUrlRef.current;
      audioUrlRef.current = url;
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
        managedObjectUrls.current.delete(previousUrl);
      }
      stopPlayback();
      clearTakes();
      setAudioUrl(url);
      setFileName(file.name);
      setCurrentTime(0);
      setDuration(decoded.duration);
      setLoopStart(0);
      setLoopEnd(Math.min(decoded.duration, 8));
      setPeaks(normalizedPeaks);
      setMarkers([]);
      setPhraseNote("");
      setPracticePass("shadow");
      setPlaying(false);
      setRecordError("");
    } catch (error) {
      if (mounted.current && generation === loadGeneration.current) {
        setLoadError(error instanceof Error ? error.message : "The browser could not decode that audio file.");
      }
    } finally {
      if (mounted.current && generation === loadGeneration.current) setLoadingFile(false);
    }
  };

  const onMetadata = () => {
    const value = audio.current?.duration ?? 0;
    setDuration(value); setLoopStart(0); setLoopEnd(Math.min(value, 8));
  };
  const onTime = () => {
    const element = audio.current;
    if (!element) return;
    if (loopEnabled && loopEnd > loopStart && element.currentTime >= loopEnd) element.currentTime = loopStart;
    setCurrentTime(element.currentTime);
  };
  const togglePlayback = async () => {
    const element = audio.current;
    if (!element) return;
    if (playbackDesired.current || !element.paused) {
      stopPlayback();
      return;
    }
    const generation = ++playbackGeneration.current;
    playbackDesired.current = true;
    try {
      if (loopEnabled && (element.currentTime < loopStart || element.currentTime >= loopEnd)) {
        element.currentTime = loopStart;
      }
      await element.play();
      if (
        !mounted.current
        || generation !== playbackGeneration.current
        || audio.current !== element
        || !playbackDesired.current
      ) {
        if (audio.current !== element || !playbackDesired.current) element.pause();
        return;
      }
      setLoadError("");
    } catch (error) {
      if (
        !mounted.current
        || generation !== playbackGeneration.current
        || audio.current !== element
      ) return;
      playbackDesired.current = false;
      setPlaying(false);
      setLoadError(error instanceof Error ? error.message : "The selected audio could not play.");
    }
  };
  const seekFromWaveform = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!audio.current || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    audio.current.currentTime = ((event.clientX - rect.left) / rect.width) * duration;
    setCurrentTime(audio.current.currentTime);
  };

  const startRecording = async () => {
    if (recorder.current || recordingStarting) return;
    const generation = ++recordingGeneration.current;
    setRecordingStarting(true);
    setRecordError("");
    try {
      // Always resume the shared AudioContext as well as retaining/opening the
      // stream; an active permission track alone does not guarantee PCM frames.
      const info = await input.enable();
      if (!mounted.current || generation !== recordingGeneration.current) return;
      const stream = input.getStream();
      if (!info || !stream?.active) throw new Error("Could not open the microphone. Check the live input panel and browser permission.");

      const takeChunks: Blob[] = [];
      let encodedBytes = 0;
      let discardReason = "";
      const next = new MediaRecorder(stream);
      recorder.current = next;
      next.ondataavailable = (event) => {
        if (!event.data.size || discardReason) return;
        encodedBytes += event.data.size;
        if (encodedBytes > MAX_LOCAL_AUDIO_FILE_BYTES) {
          discardReason = `The take exceeded ${formatFileSize(MAX_LOCAL_AUDIO_FILE_BYTES)} and was discarded.`;
          if (next.state !== "inactive") next.stop();
          return;
        }
        takeChunks.push(event.data);
      };
      next.onstop = () => {
        if (recordingStopTimer.current !== undefined) window.clearTimeout(recordingStopTimer.current);
        recordingStopTimer.current = undefined;
        if (recorder.current === next) {
          recorder.current = undefined;
          if (mounted.current) setRecording(false);
        }
        if (!mounted.current) return;
        if (discardReason) {
          setRecordError(discardReason);
          return;
        }
        const blob = new Blob(takeChunks, { type: next.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setRecordError("The recorder produced an empty take. No take was added.");
          return;
        }
        const url = URL.createObjectURL(blob);
        managedObjectUrls.current.add(url);
        const nextTake = { id: crypto.randomUUID(), url, createdAt: new Date() };
        const previousTakes = takesRef.current;
        const nextTakes = [nextTake, ...previousTakes].slice(0, 4);
        previousTakes.slice(3).forEach((take) => {
          URL.revokeObjectURL(take.url);
          managedObjectUrls.current.delete(take.url);
        });
        takesRef.current = nextTakes;
        setTakes(nextTakes);
      };
      next.onerror = () => {
        discardReason = "The browser recorder failed; no take was added.";
        if (next.state !== "inactive") next.stop();
      };
      next.start(MEDIA_RECORDER_TIMESLICE_MS);
      recordingStopTimer.current = window.setTimeout(() => {
        if (recorder.current !== next || next.state === "inactive") return;
        setRecordError(`Take stopped at the ${formatTime(MAX_LOCAL_AUDIO_DURATION_SECONDS)} local recording limit.`);
        next.stop();
      }, MAX_LOCAL_AUDIO_DURATION_SECONDS * 1_000);
      setRecordingStarting(false);
      setRecording(true);
      if (audio.current?.paused) void togglePlayback();
    } catch (error) {
      recorder.current = undefined;
      if (mounted.current && generation === recordingGeneration.current) {
        setRecordingStarting(false);
        setRecordError(error instanceof Error ? error.message : "Could not start recording.");
      }
    }
  };
  const stopRecording = () => {
    recordingGeneration.current += 1;
    setRecordingStarting(false);
    if (recordingStopTimer.current !== undefined) window.clearTimeout(recordingStopTimer.current);
    recordingStopTimer.current = undefined;
    const activeRecorder = recorder.current;
    if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
    else setRecording(false);
    stopPlayback();
  };

  const passCopy: Record<PracticePass, { title: string; mission: string; detail: string }> = {
    shadow: { title: "Shadow", mission: "Reproduce the original as precisely as you can.", detail: "Borrow timing, contour, vowel, attack, and release before analyzing." },
    understand: { title: "Understand", mission: "Name the notes, movements, and chord roles.", detail: "Translate the heard phrase into an explicit harmonic map." },
    mutate: { title: "Mutate", mission: "Sing another valid line over the same chords.", detail: "Keep the harmonic problem; change the melodic solution." }
  };

  return (
    <div className="page song-page">
      <div className="lab-intro"><div><Eyebrow>Final integration · manual first</Eyebrow><h1>Copy it. Understand it. Change it.</h1><p>Local loops, manual harmonic context, and opt-in voice takes. No fake-mustache promise of automatic full-song transcription.</p></div><label className="file-button" aria-disabled={loadingFile || recording || recordingStarting}><Icon name="song" size={18} /> {loadingFile ? "Decoding locally…" : "Load local audio"}<input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" disabled={loadingFile || recording || recordingStarting} onChange={loadFile} /></label></div>

      {loadError && <div className="error-banner"><strong>Local audio needs attention.</strong><span>{loadError}</span></div>}

      {!audioUrl ? <Panel className="song-empty"><div className="drop-record"><Icon name="song" size={35} /><span className="record-grooves" /></div><h2>Bring one phrase, not a whole production problem.</h2><p>Choose a non-empty local audio file up to {formatFileSize(MAX_LOCAL_AUDIO_FILE_BYTES)} and {formatTime(MAX_LOCAL_AUDIO_DURATION_SECONDS)}. NoteForge decodes its visual overview in memory and never uploads it.</p><label className="file-button primary" aria-disabled={loadingFile}><Icon name="arrow" size={18} /> {loadingFile ? "Decoding locally…" : "Choose audio file"}<input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" disabled={loadingFile} onChange={loadFile} /></label><div className="song-starter-steps"><span><b>01</b> manual loop</span><span><b>02</b> manual key + chords</span><span><b>03</b> contour + comparison</span></div></Panel> : <>
        <audio
          key={audioUrl}
          ref={audio}
          src={audioUrl}
          onLoadedMetadata={onMetadata}
          onTimeUpdate={onTime}
          onPlay={() => {
            if (!playbackDesired.current) {
              audio.current?.pause();
              return;
            }
            setPlaying(true);
          }}
          onPause={() => {
            if (playbackDesired.current) {
              playbackGeneration.current += 1;
              playbackDesired.current = false;
            }
            setPlaying(false);
          }}
          onEnded={() => {
            playbackGeneration.current += 1;
            playbackDesired.current = false;
            setPlaying(false);
          }}
          onError={() => {
            playbackGeneration.current += 1;
            playbackDesired.current = false;
            setPlaying(false);
            setLoadError("The decoded local audio could not be played by the media element.");
          }}
        />
        <Panel className="transport-panel">
          <div className="track-meta"><span className="album-placeholder"><Icon name="song" /></span><div><small>LOCAL AUDIO</small><b>{fileName}</b><span>{formatTime(duration)} · never uploaded</span></div></div>
          <div className="waveform" onClick={seekFromWaveform}>{peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(5, peak * 90)}%` }} className={(index / peaks.length) * duration >= loopStart && (index / peaks.length) * duration <= loopEnd ? "in-loop" : ""} />)}<span className="loop-region" style={{ left: `${duration ? loopStart / duration * 100 : 0}%`, width: `${duration ? (loopEnd - loopStart) / duration * 100 : 0}%` }} /><span className="song-playhead" style={{ left: `${duration ? currentTime / duration * 100 : 0}%` }} />{markers.map((marker, index) => <span key={index} className={`song-marker ${marker.type}`} style={{ left: `${duration ? marker.time / duration * 100 : 0}%` }}>{marker.type === "breath" ? "B" : "P"}</span>)}</div>
          <div className="transport-controls"><div className="timecode"><b>{formatTime(currentTime)}</b><span>/ {formatTime(duration)}</span></div><button onClick={() => { if (audio.current) audio.current.currentTime = Math.max(loopStart, audio.current.currentTime - 2); }}>−2</button><button className="main-transport" onClick={togglePlayback}><Icon name={playing ? "pause" : "play"} size={20} /></button><button onClick={() => { if (audio.current) audio.current.currentTime = Math.min(loopEnabled ? loopEnd : duration, audio.current.currentTime + 2); }}>+2</button><button className={loopEnabled ? "loop-active" : ""} aria-pressed={loopEnabled} onClick={() => setLoopEnabled((current) => !current)}><Icon name="loop" size={17} /> LOOP</button><div className="timecode right"><b>{formatTime(loopEnd - loopStart)}</b><span>phrase</span></div></div>
          <div className="loop-handles"><label><span>LOOP IN</span><input type="range" min="0" max={duration} step=".05" value={loopStart} onChange={(event) => setLoopStart(Math.min(Number(event.target.value), loopEnd - .1))} /><b>{formatTime(loopStart)}</b></label><label><span>LOOP OUT</span><input type="range" min="0" max={duration} step=".05" value={loopEnd} onChange={(event) => setLoopEnd(Math.max(Number(event.target.value), loopStart + .1))} /><b>{formatTime(loopEnd)}</b></label></div>
        </Panel>

        <div className="song-settings-grid">
          <Panel className="transport-settings"><Eyebrow>Transport</Eyebrow><div><Select label="Speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value=".5">50%</option><option value=".65">65%</option><option value=".75">75%</option><option value=".85">85%</option><option value="1">100%</option></Select><Select label="Transpose preview" value={transpose} onChange={(event) => setTranspose(Number(event.target.value))}>{Array.from({ length: 13 }, (_, index) => index - 6).map((semi) => <option value={semi} key={semi}>{semi > 0 ? "+" : ""}{semi} semitones</option>)}</Select></div><small>{transpose === 0 ? "Slow playback uses the browser’s pitch-preserving media path when available." : "Transpose preview is rate-based in this milestone, so transport speed also changes."}</small></Panel>
          <Panel className="manual-context"><Eyebrow>Manual harmonic map</Eyebrow><div><Select label="Known key" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>{Array.from({ length: 12 }, (_, pc) => <option key={pc} value={pc}>{pitchClassLabel(pc)}</option>)}</Select><label className="field"><span>Chord progression</span><input value={chords} maxLength={MAX_PHRASE_TEXT_LENGTH} onChange={(event) => setChords(event.target.value)} placeholder="C | Am | F | G" /></label></div><small>Tap or type what you know. Automatic chord detection is intentionally out of scope.</small></Panel>
          <Panel className="phrase-markers"><Eyebrow>Phrase notebook</Eyebrow><div><ActionButton disabled={markers.length >= MAX_MARKERS} onClick={() => setMarkers((current) => current.length >= MAX_MARKERS ? current : [...current, { time: currentTime, type: "phrase" }])}>+ Phrase boundary</ActionButton><ActionButton disabled={markers.length >= MAX_MARKERS} onClick={() => setMarkers((current) => current.length >= MAX_MARKERS ? current : [...current, { time: currentTime, type: "breath" }])}>+ Breath point</ActionButton></div><label className="field"><span>Intended notes / degrees</span><input value={phraseNote} maxLength={MAX_PHRASE_TEXT_LENGTH} onChange={(event) => setPhraseNote(event.target.value)} placeholder="3 – 2 – 1 · land on E" /></label><small>{markers.length}/{MAX_MARKERS} markers · {phraseNote.length}/{MAX_PHRASE_TEXT_LENGTH} characters</small></Panel>
        </div>

        <NoteInput variant="scope" input={input} title="Voice take input" />

        <Panel className="three-passes"><div className="panel-heading"><div><Eyebrow>One selected phrase · three passes</Eyebrow><h2>{passCopy[practicePass].title}</h2></div><Segmented value={practicePass} onChange={setPracticePass} options={[{ value: "shadow", label: "1 · Shadow" }, { value: "understand", label: "2 · Understand" }, { value: "mutate", label: "3 · Mutate" }]} /></div><div className="pass-mission"><span className={`pass-symbol ${practicePass}`}><Icon name={practicePass === "shadow" ? "mirror" : practicePass === "understand" ? "skills" : "spark"} size={28} /></span><div><small>CURRENT PASS</small><h3>{passCopy[practicePass].mission}</h3><p>{passCopy[practicePass].detail}</p></div></div><div className="record-strip"><div className="headphone-note"><Icon name="headphones" size={20} /><span><b>Use headphones.</b><small>The scope and saved take use the same minimally processed microphone stream.</small></span></div><ActionButton disabled={recordingStarting} className={recording ? "recording coral" : "primary"} onClick={recording ? stopRecording : startRecording}><Icon name="record" size={17} /> {recording ? "Stop voice take" : recordingStarting ? "Opening microphone…" : "Record voice against loop"}</ActionButton></div>{recordError && <div className="error-banner">{recordError}</div>}</Panel>

        {takes.length > 0 && <Panel className="takes-panel"><div className="panel-heading"><div><Eyebrow>Temporary comparison</Eyebrow><h2>Voice takes</h2></div><span className="local-badge">memory only</span></div><div className="takes-list">{takes.map((take, index) => <div key={take.id}><span>TAKE {takes.length - index}</span><audio controls src={take.url} /><small>{take.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>)}</div></Panel>}
      </>}
    </div>
  );
}
