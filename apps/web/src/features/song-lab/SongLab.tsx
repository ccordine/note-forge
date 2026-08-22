import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useAudioInput } from "@/audio/use-audio-input";
import { pitchClassLabel } from "@/lib/music-display";
import { useLab } from "@/state/LabContext";
import { ActionButton, Eyebrow, Panel, Segmented, Select } from "@/ui/Controls";
import { Icon } from "@/ui/Icon";
import { InputScope } from "@/ui/InputScope";

type PracticePass = "shadow" | "understand" | "mutate";

interface VoiceTake { id: string; url: string; createdAt: Date; }

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export function SongLab() {
  const { tonicPitchClass, setTonicPitchClass } = useLab();
  const input = useAudioInput({
    detector: { minFrequency: 65, maxFrequency: 1_100, analysisWindowSize: "maximum", minConfidence: .65 },
    maxFrames: 360
  });
  const [audioUrl, setAudioUrl] = useState<string>();
  const [fileName, setFileName] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);
  const [speed, setSpeed] = useState(.85);
  const [transpose, setTranspose] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [practicePass, setPracticePass] = useState<PracticePass>("shadow");
  const [chords, setChords] = useState("C | Am | F | G");
  const [phraseNote, setPhraseNote] = useState("");
  const [markers, setMarkers] = useState<{ time: number; type: "breath" | "phrase" }[]>([]);
  const [recording, setRecording] = useState(false);
  const [takes, setTakes] = useState<VoiceTake[]>([]);
  const [recordError, setRecordError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const chunks = useRef<Blob[]>([]);
  const mounted = useRef(false);
  const audioUrlRef = useRef<string | undefined>(undefined);
  const takesRef = useRef<VoiceTake[]>([]);
  const managedObjectUrls = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const activeRecorder = recorder.current;
      recorder.current = undefined;
      if (activeRecorder && activeRecorder.state !== "inactive") {
        activeRecorder.ondataavailable = null;
        activeRecorder.onstop = null;
        try { activeRecorder.stop(); } catch { /* The recorder may have stopped between the state check and cleanup. */ }
      }
      chunks.current = [];
      input.stop();
      managedObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      managedObjectUrls.current.clear();
      audioUrlRef.current = undefined;
      takesRef.current = [];
    };
  }, [input.stop]);

  useEffect(() => {
    if (!audio.current) return;
    audio.current.playbackRate = speed * 2 ** (transpose / 12);
    audio.current.preservesPitch = transpose === 0;
  }, [speed, transpose]);

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      managedObjectUrls.current.delete(audioUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    managedObjectUrls.current.add(url);
    audioUrlRef.current = url;
    setAudioUrl(url); setFileName(file.name); setCurrentTime(0); setPeaks([]);
    try {
      const buffer = await file.arrayBuffer();
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const channel = decoded.getChannelData(0);
      const bins = 240;
      const bucket = Math.max(1, Math.floor(channel.length / bins));
      const nextPeaks = Array.from({ length: bins }, (_, index) => {
        let peak = 0;
        for (let sample = index * bucket; sample < Math.min(channel.length, (index + 1) * bucket); sample += 8) peak = Math.max(peak, Math.abs(channel[sample]));
        return peak;
      });
      const max = Math.max(...nextPeaks, .001);
      setPeaks(nextPeaks.map((peak) => peak / max));
      await context.close();
    } catch { setPeaks([]); }
  };

  const onMetadata = () => {
    const value = audio.current?.duration ?? 0;
    setDuration(value); setLoopStart(0); setLoopEnd(Math.min(value, 8));
  };
  const onTime = () => {
    const element = audio.current;
    if (!element) return;
    if (loopEnd > loopStart && element.currentTime >= loopEnd) element.currentTime = loopStart;
    setCurrentTime(element.currentTime);
  };
  const togglePlayback = async () => {
    if (!audio.current) return;
    if (audio.current.paused) { if (audio.current.currentTime < loopStart || audio.current.currentTime >= loopEnd) audio.current.currentTime = loopStart; await audio.current.play(); setPlaying(true); }
    else { audio.current.pause(); setPlaying(false); }
  };
  const seekFromWaveform = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!audio.current || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    audio.current.currentTime = ((event.clientX - rect.left) / rect.width) * duration;
    setCurrentTime(audio.current.currentTime);
  };

  const startRecording = async () => {
    setRecordError("");
    try {
      if (recorder.current) return;
      let stream = input.getStream();
      if (!stream?.active) {
        if (input.state === "ready") input.stop();
        const info = await input.start();
        if (!mounted.current) {
          input.stop();
          return;
        }
        stream = input.getStream();
        if (!info || !stream?.active) throw new Error("Could not open the microphone. Check the live input panel and browser permission.");
      }

      const takeChunks: Blob[] = [];
      chunks.current = takeChunks;
      const next = new MediaRecorder(stream);
      recorder.current = next;
      next.ondataavailable = (event) => { if (event.data.size) takeChunks.push(event.data); };
      next.onstop = () => {
        if (recorder.current === next) {
          recorder.current = undefined;
          if (mounted.current) setRecording(false);
        }
        if (!mounted.current) return;
        const blob = new Blob(takeChunks, { type: next.mimeType || "audio/webm" });
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
      next.start();
      setRecording(true);
      if (audio.current?.paused) void togglePlayback();
    } catch (error) {
      recorder.current = undefined;
      if (mounted.current) setRecordError(error instanceof Error ? error.message : "Could not start recording.");
    }
  };
  const stopRecording = () => {
    const activeRecorder = recorder.current;
    if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
    else setRecording(false);
    audio.current?.pause();
    setPlaying(false);
  };

  const passCopy: Record<PracticePass, { title: string; mission: string; detail: string }> = {
    shadow: { title: "Shadow", mission: "Reproduce the original as precisely as you can.", detail: "Borrow timing, contour, vowel, attack, and release before analyzing." },
    understand: { title: "Understand", mission: "Name the notes, movements, and chord roles.", detail: "Translate the heard phrase into an explicit harmonic map." },
    mutate: { title: "Mutate", mission: "Sing another valid line over the same chords.", detail: "Keep the harmonic problem; change the melodic solution." }
  };

  return (
    <div className="page song-page">
      <div className="lab-intro"><div><Eyebrow>Final integration · manual first</Eyebrow><h1>Copy it. Understand it. Change it.</h1><p>Local loops, manual harmonic context, and opt-in voice takes. No fake-mustache promise of automatic full-song transcription.</p></div><label className="file-button"><Icon name="song" size={18} /> Load local audio<input type="file" accept="audio/*" onChange={loadFile} /></label></div>

      {!audioUrl ? <Panel className="song-empty"><div className="drop-record"><Icon name="song" size={35} /><span className="record-grooves" /></div><h2>Bring one phrase, not a whole production problem.</h2><p>Choose a local audio file. NoteForge will decode a visual overview in memory and never upload it.</p><label className="file-button primary"><Icon name="arrow" size={18} /> Choose audio file<input type="file" accept="audio/*" onChange={loadFile} /></label><div className="song-starter-steps"><span><b>01</b> manual loop</span><span><b>02</b> manual key + chords</span><span><b>03</b> contour + comparison</span></div></Panel> : <>
        <audio ref={audio} src={audioUrl} onLoadedMetadata={onMetadata} onTimeUpdate={onTime} onEnded={() => setPlaying(false)} />
        <Panel className="transport-panel">
          <div className="track-meta"><span className="album-placeholder"><Icon name="song" /></span><div><small>LOCAL AUDIO</small><b>{fileName}</b><span>{formatTime(duration)} · never uploaded</span></div></div>
          <div className="waveform" onClick={seekFromWaveform}>{(peaks.length ? peaks : Array.from({ length: 180 }, (_, index) => .15 + Math.abs(Math.sin(index * .31)) * .5)).map((peak, index) => <i key={index} style={{ height: `${Math.max(5, peak * 90)}%` }} className={(index / (peaks.length || 180)) * duration >= loopStart && (index / (peaks.length || 180)) * duration <= loopEnd ? "in-loop" : ""} />)}<span className="loop-region" style={{ left: `${duration ? loopStart / duration * 100 : 0}%`, width: `${duration ? (loopEnd - loopStart) / duration * 100 : 0}%` }} /><span className="song-playhead" style={{ left: `${duration ? currentTime / duration * 100 : 0}%` }} />{markers.map((marker, index) => <span key={index} className={`song-marker ${marker.type}`} style={{ left: `${duration ? marker.time / duration * 100 : 0}%` }}>{marker.type === "breath" ? "B" : "P"}</span>)}</div>
          <div className="transport-controls"><div className="timecode"><b>{formatTime(currentTime)}</b><span>/ {formatTime(duration)}</span></div><button onClick={() => { if (audio.current) audio.current.currentTime = Math.max(loopStart, audio.current.currentTime - 2); }}>−2</button><button className="main-transport" onClick={togglePlayback}><Icon name={playing ? "pause" : "play"} size={20} /></button><button onClick={() => { if (audio.current) audio.current.currentTime = Math.min(loopEnd, audio.current.currentTime + 2); }}>+2</button><button className="loop-active"><Icon name="loop" size={17} /> LOOP</button><div className="timecode right"><b>{formatTime(loopEnd - loopStart)}</b><span>phrase</span></div></div>
          <div className="loop-handles"><label><span>LOOP IN</span><input type="range" min="0" max={duration} step=".05" value={loopStart} onChange={(event) => setLoopStart(Math.min(Number(event.target.value), loopEnd - .1))} /><b>{formatTime(loopStart)}</b></label><label><span>LOOP OUT</span><input type="range" min="0" max={duration} step=".05" value={loopEnd} onChange={(event) => setLoopEnd(Math.max(Number(event.target.value), loopStart + .1))} /><b>{formatTime(loopEnd)}</b></label></div>
        </Panel>

        <div className="song-settings-grid">
          <Panel className="transport-settings"><Eyebrow>Transport</Eyebrow><div><Select label="Speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value=".5">50%</option><option value=".65">65%</option><option value=".75">75%</option><option value=".85">85%</option><option value="1">100%</option></Select><Select label="Transpose preview" value={transpose} onChange={(event) => setTranspose(Number(event.target.value))}>{Array.from({ length: 13 }, (_, index) => index - 6).map((semi) => <option value={semi} key={semi}>{semi > 0 ? "+" : ""}{semi} semitones</option>)}</Select></div><small>{transpose === 0 ? "Slow playback uses the browser’s pitch-preserving media path when available." : "Transpose preview is rate-based in this milestone, so transport speed also changes."}</small></Panel>
          <Panel className="manual-context"><Eyebrow>Manual harmonic map</Eyebrow><div><Select label="Known key" value={tonicPitchClass} onChange={(event) => setTonicPitchClass(Number(event.target.value))}>{Array.from({ length: 12 }, (_, pc) => <option key={pc} value={pc}>{pitchClassLabel(pc)}</option>)}</Select><label className="field"><span>Chord progression</span><input value={chords} onChange={(event) => setChords(event.target.value)} placeholder="C | Am | F | G" /></label></div><small>Tap or type what you know. Automatic chord detection is intentionally out of scope.</small></Panel>
          <Panel className="phrase-markers"><Eyebrow>Phrase notebook</Eyebrow><div><ActionButton onClick={() => setMarkers((current) => [...current, { time: currentTime, type: "phrase" }])}>+ Phrase boundary</ActionButton><ActionButton onClick={() => setMarkers((current) => [...current, { time: currentTime, type: "breath" }])}>+ Breath point</ActionButton></div><label className="field"><span>Intended notes / degrees</span><input value={phraseNote} onChange={(event) => setPhraseNote(event.target.value)} placeholder="3 – 2 – 1 · land on E" /></label></Panel>
        </div>

        <InputScope input={input} title="Voice take input" busy={recording} showPitch />

        <Panel className="three-passes"><div className="panel-heading"><div><Eyebrow>One selected phrase · three passes</Eyebrow><h2>{passCopy[practicePass].title}</h2></div><Segmented value={practicePass} onChange={setPracticePass} options={[{ value: "shadow", label: "1 · Shadow" }, { value: "understand", label: "2 · Understand" }, { value: "mutate", label: "3 · Mutate" }]} /></div><div className="pass-mission"><span className={`pass-symbol ${practicePass}`}><Icon name={practicePass === "shadow" ? "mirror" : practicePass === "understand" ? "skills" : "spark"} size={28} /></span><div><small>CURRENT PASS</small><h3>{passCopy[practicePass].mission}</h3><p>{passCopy[practicePass].detail}</p></div></div><div className="record-strip"><div className="headphone-note"><Icon name="headphones" size={20} /><span><b>Use headphones.</b><small>The scope and saved take use the same minimally processed microphone stream.</small></span></div><ActionButton disabled={!recording && (input.state === "starting" || input.calibration.status === "calibrating")} className={recording ? "recording coral" : "primary"} onClick={recording ? stopRecording : startRecording}><Icon name="record" size={17} /> {recording ? "Stop voice take" : "Record voice against loop"}</ActionButton></div>{recordError && <div className="error-banner">{recordError}</div>}</Panel>

        {takes.length > 0 && <Panel className="takes-panel"><div className="panel-heading"><div><Eyebrow>Temporary comparison</Eyebrow><h2>Voice takes</h2></div><span className="local-badge">memory only</span></div><div className="takes-list">{takes.map((take, index) => <div key={take.id}><span>TAKE {takes.length - index}</span><audio controls src={take.url} /><small>{take.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>)}</div></Panel>}
      </>}
    </div>
  );
}
