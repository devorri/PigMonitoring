import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioWaveform,
  Upload,
  Mic,
  Square,
  Play,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Info,
  RotateCcw,
} from 'lucide-react';
import type { SystemSetting } from '../types';
import {
  AUDIO_CLASSES,
  SAMPLE_RATE,
  analyzeAudio,
  coughSettingsFrom,
  decodeTo16kMono,
  loadAudioModel,
  type AnalysisResult,
  type CoughCheck,
  type CoughSettings,
} from '../lib/coughDetector';
import { sendSmsFromWeb } from '../lib/sms';
import './AudioTesterView.css';

const MAX_SECONDS = 120;
const MAX_RECORD_SECONDS = 30;

interface AudioTesterViewProps {
  settings: SystemSetting[];
}

type Stage = 'idle' | 'model' | 'decoding' | 'analyzing' | 'done' | 'error';

export const AudioTesterView: React.FC<AudioTesterViewProps> = ({ settings }) => {
  const piSettings = useMemo(() => coughSettingsFrom(settings), [settings]);
  // null = follow the Pi's audio_threshold from Settings
  const [thresholdOverride, setThreshold] = useState<number | null>(null);
  const threshold = thresholdOverride ?? piSettings.threshold;
  const [useGate, setUseGate] = useState(true);

  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  // Simulation: text the active contacts when the uploaded audio has a cough
  const [smsOnCough, setSmsOnCough] = useState(true);
  const [smsState, setSmsState] = useState<{ kind: 'sending' | 'sent' | 'failed'; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimer = useRef<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const effective: CoughSettings = { ...piSettings, threshold, useGate };

  const sendCoughSms = async (r: AnalysisResult, name: string) => {
    setSmsState({ kind: 'sending', text: 'Cough found. Sending SMS to the active contacts…' });
    const res = await sendSmsFromWeb('sim_upload', undefined, {
      coughs: r.coughs.length,
      best: Math.max(...r.coughs.map((c) => c.score)),
      file: name,
    });
    setSmsState(
      res.ok
        ? { kind: 'sent', text: `SMS sent to ${res.numbers.length} contact${res.numbers.length === 1 ? '' : 's'}: "${res.message}"` }
        : { kind: 'failed', text: `SMS not sent: ${res.error}` },
    );
  };

  const run = async (x: Float32Array, st: CoughSettings, smsName?: string) => {
    setError(null);
    setResult(null);
    setShowRejected(false);
    setSmsState(null);
    try {
      setStage('model');
      setProgress(0);
      const session = await loadAudioModel((loaded, total) => setProgress(total ? loaded / total : 0));
      setStage('analyzing');
      setProgress(0);
      const r = await analyzeAudio(session, x, st, setProgress);
      setResult(r);
      setStage('done');
      if (smsName && smsOnCough && r.coughs.length > 0) void sendCoughSms(r, smsName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  };

  const handleBlob = async (blob: Blob, name: string) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(blob));
    setFileName(name);
    setResult(null);
    setError(null);
    setStage('decoding');
    try {
      let x = await decodeTo16kMono(blob);
      const cut = x.length > MAX_SECONDS * SAMPLE_RATE;
      if (cut) x = x.slice(0, MAX_SECONDS * SAMPLE_RATE);
      setTruncated(cut);
      setSamples(x);
      await run(x, effective, name);
    } catch (e) {
      setError(
        `Couldn't read this file (${e instanceof Error ? e.message : String(e)}). ` +
          'Try a .wav, .mp3, .m4a or .ogg recording.',
      );
      setStage('error');
    }
  };

  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void handleBlob(f, f.name);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const rec = new MediaRecorder(stream);
      const parts: Blob[] = [];
      rec.ondataavailable = (ev) => ev.data.size && parts.push(ev.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimer.current) window.clearInterval(recordTimer.current);
        setRecording(false);
        const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
        void handleBlob(blob, `Recording ${new Date().toLocaleTimeString()}`);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordSecs(0);
      const started = Date.now();
      recordTimer.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setRecordSecs(s);
        if (s >= MAX_RECORD_SECONDS && rec.state === 'recording') rec.stop();
      }, 250);
    } catch {
      setError('Microphone not available. Allow mic access in the browser, or upload a file instead.');
      setStage('error');
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const playAt = (t: number, len = 1.5) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, t - 0.5);
    stopAtRef.current = a.currentTime + len;
    void a.play();
  };

  const onTimeUpdate = () => {
    const a = audioRef.current;
    if (a && stopAtRef.current !== null && a.currentTime >= stopAtRef.current) {
      a.pause();
      stopAtRef.current = null;
    }
  };

  const rerun = (override?: Partial<CoughSettings>) => {
    if (!samples) return;
    if (override?.useGate !== undefined) setUseGate(override.useGate);
    void run(samples, { ...effective, ...override });
  };

  const busy = stage === 'model' || stage === 'decoding' || stage === 'analyzing';
  const settingsChanged = result && (threshold !== piSettings.threshold || !useGate);

  return (
    <div className="at-page">
      {/* Header */}
      <div className="glass-panel at-panel">
        <div className="panel-header">
          <div className="panel-title-area">
            <AudioWaveform className="panel-icon" style={{ color: '#db2777' }} />
            <div>
              <h2 className="panel-title">Cough Tester</h2>
              <p className="panel-subtitle">
                Upload or record a pig sound. The same AI and cough rules the Raspberry Pi uses will check it. It
                runs in your browser, so nothing is uploaded.
              </p>
            </div>
          </div>
        </div>

        {/* Input */}
        <div
          className={`at-drop ${dragOver ? 'over' : ''} ${busy || recording ? 'disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!busy && !recording) onFiles(e.dataTransfer.files);
          }}
          onClick={() => !busy && !recording && fileInputRef.current?.click()}
        >
          <Upload className="at-drop-icon" />
          <div className="at-drop-title">Drop an audio file here or click to choose</div>
          <div className="at-drop-sub">.wav .mp3 .m4a .ogg .webm, up to {MAX_SECONDS}s</div>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.aac,.flac"
            hidden
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        <div className="at-actions">
          {!recording ? (
            <button className="primary-btn" onClick={startRecording} disabled={busy}>
              <Mic className="btn-icon" /> Record from mic
            </button>
          ) : (
            <button className="at-stop-btn" onClick={stopRecording}>
              <Square className="btn-icon" /> Stop ({recordSecs}s / {MAX_RECORD_SECONDS}s)
            </button>
          )}

          <div className="at-controls">
            <label className="at-slider">
              <span>
                Cough threshold <b>{Math.round(threshold * 100)}%</b>
                {threshold !== piSettings.threshold && (
                  <em> (Pi uses {Math.round(piSettings.threshold * 100)}%)</em>
                )}
              </span>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
                disabled={busy}
              />
            </label>
            <label className="at-check">
              <input type="checkbox" checked={smsOnCough} onChange={(e) => setSmsOnCough(e.target.checked)} disabled={busy} />
              Send SMS when a cough is found
            </label>
            <label className="at-check">
              <input type="checkbox" checked={useGate} onChange={(e) => setUseGate(e.target.checked)} disabled={busy} />
              Skip quiet parts (like the Pi, min {piSettings.minDb} dB)
            </label>
            {samples && (
              <button className="secondary-btn" onClick={() => rerun()} disabled={busy}>
                <RotateCcw className="btn-icon" /> Re-check
              </button>
            )}
          </div>
        </div>

        {/* Progress / errors */}
        {busy && (
          <div className="at-progress">
            <Loader2 className="at-spin" />
            <span>
              {stage === 'decoding' && 'Reading audio...'}
              {stage === 'model' && `Loading AI model (≈45 MB, first time only) ${Math.round(progress * 100)}%`}
              {stage === 'analyzing' && `Listening for coughs... ${Math.round(progress * 100)}%`}
            </span>
            <div className="at-bar">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}
        {error && (
          <div className="at-error">
            <AlertTriangle className="btn-icon" /> {error}
          </div>
        )}
      </div>

      {/* Result */}
      {audioUrl && (stage === 'done' || result) && result && (
        <div className="glass-panel at-panel">
          <div className={`at-verdict ${result.coughs.length ? 'cough' : 'clear'}`}>
            {result.coughs.length ? <AlertTriangle className="at-verdict-icon" /> : <CheckCircle2 className="at-verdict-icon" />}
            <div>
              <div className="at-verdict-title">
                {result.coughs.length
                  ? `COUGH DETECTED: ${result.coughs.length} cough${result.coughs.length > 1 ? 's' : ''}`
                  : 'NO COUGH DETECTED'}
              </div>
              <div className="at-verdict-sub">
                {fileName} · {result.duration.toFixed(1)}s
                {result.coughs.length > 0 &&
                  ` · best ${Math.round(Math.max(...result.coughs.map((c) => c.score)) * 100)}% confidence`}
                {result.coughs.length > 0 &&
                  (result.attention
                    ? ` · the Pi would raise ATTENTION NEEDED (≥ ${piSettings.alertMin} coughs)`
                    : ` · the Pi alerts at ${piSettings.alertMin}+ coughs per interval`)}
              </div>
            </div>
          </div>

          {truncated && (
            <div className="at-note">
              <Info className="btn-icon" /> Only the first {MAX_SECONDS}s were checked.
            </div>
          )}
          {smsState && (
            <div className={`at-note ${smsState.kind === 'failed' ? 'warn' : ''}`}>
              <Info className="btn-icon" /> <span>{smsState.text}</span>
            </div>
          )}
          {result.coughs.length > 0 && !smsState && (
            <div className="at-note">
              <Info className="btn-icon" />
              <span>No SMS sent for this check.</span>
              <button className="secondary-btn" onClick={() => void sendCoughSms(result, fileName ?? 'audio')}>
                Send SMS now
              </button>
            </div>
          )}
          {settingsChanged && (
            <div className="at-note">
              <Info className="btn-icon" /> Checked with test settings that differ from the Pi's. Change them in
              Settings if you want the Pi to use them.
            </div>
          )}
          {useGate && result.quietShare > 0.8 && result.coughs.length === 0 && (
            <div className="at-note warn">
              <Info className="btn-icon" />
              <span>
                {Math.round(result.quietShare * 100)}% of this recording was too quiet to check (phone recordings are
                often quieter than the barn mic).
              </span>
              <button className="secondary-btn" onClick={() => rerun({ useGate: false })}>
                Check everything
              </button>
            </div>
          )}

          <audio ref={audioRef} src={audioUrl} controls className="at-audio" onTimeUpdate={onTimeUpdate} />

          <Timeline result={result} threshold={threshold} onSeek={(t) => playAt(t)} />

          {result.coughs.length > 0 && (
            <div className="at-list">
              <h3>Coughs found</h3>
              {result.coughs.map((c, i) => (
                <CoughRow key={`c${i}`} c={c} onPlay={() => playAt(c.time)} />
              ))}
            </div>
          )}

          {result.rejected.length > 0 && (
            <div className="at-list">
              <button className="at-toggle" onClick={() => setShowRejected((v) => !v)}>
                {showRejected ? <ChevronUp className="btn-icon" /> : <ChevronDown className="btn-icon" />}
                {result.rejected.length} sound{result.rejected.length > 1 ? 's' : ''} looked like a cough but didn't
                pass
              </button>
              {showRejected && result.rejected.map((c, i) => (
                <CoughRow key={`r${i}`} c={c} onPlay={() => playAt(c.time)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* How it works */}
      <div className="glass-panel at-panel at-how">
        <h3>How a sound counts as a cough</h3>
        <ol>
          <li>Every 1-second window is leveled to the same loudness first, so how loud or close the mic is doesn't change the answer.</li>
          <li>A window that looks like a cough gets a second look: 9 checks (3 positions around the sound's peak × 3 loudness levels), averaged.</li>
          <li>The averaged cough score must reach the threshold and beat every other class (squeal, grunt, feeding, cleaning) by at least 10%.</li>
          <li>The sound itself must look like a cough: it stands out from the background, starts fast (under 80 ms) and is short (50–700 ms). Long squeals and machine noise fail here.</li>
          <li>Each cough is counted once, even inside a quick cough bout.</li>
        </ol>
      </div>
    </div>
  );
};

const CoughRow: React.FC<{ c: CoughCheck; onPlay: () => void }> = ({ c, onPlay }) => {
  const otherI = c.probs.slice(1).reduce((best, v, i) => (v > c.probs[best] ? i + 1 : best), 1);
  return (
    <div className={`at-row ${c.ok ? 'ok' : 'no'}`}>
      <button className="at-play" onClick={onPlay} title="Play this part">
        <Play className="btn-icon" />
      </button>
      <div className="at-row-main">
        <div className="at-row-top">
          <b>{c.time.toFixed(2)}s</b>
          <span className="at-pill">cough {Math.round(c.score * 100)}%</span>
          <span className="at-pill muted">
            next: {AUDIO_CLASSES[otherI]} {Math.round(c.probs[otherI] * 100)}%
          </span>
          <span className="at-pill muted">
            rise {c.shape.riseMs} ms · {c.shape.durationMs} ms long · +{c.shape.prominenceDb} dB
          </span>
        </div>
        {!c.ok && <div className="at-reasons">{c.reasons.join(' · ')}</div>}
      </div>
    </div>
  );
};

const Timeline: React.FC<{ result: AnalysisResult; threshold: number; onSeek: (t: number) => void }> = ({
  result,
  threshold,
  onSeek,
}) => {
  const W = 1000;
  const H = 120;
  const dur = Math.max(result.duration, 1);
  const x = (t: number) => (t / dur) * W;
  const y = (p: number) => H - 14 - p * (H - 28);
  const winW = Math.max(2, (0.5 / dur) * W - 1);

  return (
    <div className="at-timeline">
      <div className="at-timeline-head">
        <span>Cough score over time</span>
        <span className="at-legend">
          <i className="lg-cough" /> confirmed cough <i className="lg-rej" /> rejected <i className="lg-quiet" /> too quiet
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="at-svg"
        onClick={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * dur);
        }}>
        <line x1={0} x2={W} y1={y(threshold)} y2={y(threshold)} className="at-thr" />
        {result.windows.map((w, i) => {
          const cx = x(w.t + 0.25);
          if (w.quiet || !w.probs) {
            return <rect key={i} x={cx} y={H - 16} width={winW} height={2} className="at-quiet" />;
          }
          const p = w.probs[0];
          return (
            <rect key={i} x={cx} y={y(p)} width={winW} height={H - 14 - y(p)}
              className={p >= threshold ? 'at-win hi' : 'at-win'}>
              <title>{`${w.t.toFixed(1)}s · ${w.level} dB · cough ${Math.round(p * 100)}%`}</title>
            </rect>
          );
        })}
        {result.rejected.map((c, i) => (
          <line key={`r${i}`} x1={x(c.time)} x2={x(c.time)} y1={4} y2={H - 14} className="at-mark-rej" />
        ))}
        {result.coughs.map((c, i) => (
          <g key={`c${i}`}>
            <line x1={x(c.time)} x2={x(c.time)} y1={4} y2={H - 14} className="at-mark-cough" />
            <circle cx={x(c.time)} cy={8} r={5} className="at-dot" />
          </g>
        ))}
      </svg>
      <div className="at-axis">
        <span>0s</span>
        <span>{(dur / 2).toFixed(1)}s</span>
        <span>{dur.toFixed(1)}s</span>
      </div>
    </div>
  );
};

export default AudioTesterView;
