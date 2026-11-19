// =====================================================================
// Cough detector for the website's Audio Tester.
// This is a 1:1 copy of the cough logic in pi/app.py (analyze_samples),
// so an uploaded file gets the same verdict the Raspberry Pi would give.
// If you change a number here, change it in pi/app.py too.
// =====================================================================
import * as ort from 'onnxruntime-web';

export const SAMPLE_RATE = 16000;
const N_FFT = 1024;
const HOP = 512;
const N_MELS = 64;
const N_FRAMES = 32;

export const AUDIO_CLASSES = [
  'Coughing / Sneezing',
  'Stress / Disputes',
  'Normal Pig Sounds',
  'Feeding Activity',
  'Cleaning / Activity',
];

const LEVEL_SET_DB = [-4, 0, 4];          // 3 loudness levels around the reference...
const COUGH_SHIFTS_S = [-0.15, 0, 0.15];  // ...x 3 positions around the peak = 9 checks
const COUGH_MARGIN = 0.1;
const COUGH_DEDUP_S = 0.3;
const ENV_FRAME = 160;                    // 10 ms
const COUGH_PROMINENCE_DB = 9;
const COUGH_RISE_MAX_MS = 80;
const COUGH_DUR_MIN_MS = 50;
const COUGH_DUR_MAX_MS = 700;
const COUGH_PAD = Math.trunc(SAMPLE_RATE * (0.56 + Math.max(...COUGH_SHIFTS_S)));
const AUDIO_ABOVE_BG_DB = 8;
const AUDIO_BG_MAX_DB = 65;

export interface CoughSettings {
  threshold: number;     // audio_threshold 0.30 - 0.95
  minDb: number;         // audio_min_db
  alertMin: number;      // cough_alert_min
  refDb: number;         // audio_ref_db
  useGate: boolean;      // skip windows quieter than the gate (like the Pi)
}

export const DEFAULT_COUGH_SETTINGS: CoughSettings = {
  threshold: 0.6,
  minDb: 50,
  alertMin: 2,
  refDb: -18,
  useGate: true,
};

export interface WindowResult {
  t: number;
  level: number;
  quiet: boolean;
  probs: number[] | null;
}

export interface CoughShape {
  ok: boolean;
  prominenceDb: number;
  riseMs: number;
  durationMs: number;
  peakOffset: number;
  reasons: string[];
}

export interface CoughCheck {
  ok: boolean;
  peak: number;          // sample index
  time: number;          // seconds
  score: number;
  margin: number;
  probs: number[];
  shape: CoughShape;
  reasons: string[];
}

export interface AnalysisResult {
  windows: WindowResult[];
  coughs: CoughCheck[];
  rejected: CoughCheck[];
  verdict: 'COUGH' | 'NO COUGH';
  attention: boolean;
  quietShare: number;
  duration: number;
}

// ---------------------------------------------------------------------
// Settings from Supabase system_settings (same parsing as the Pi)
// ---------------------------------------------------------------------
export function coughSettingsFrom(rows: { setting_key: string; setting_value: string }[]): CoughSettings {
  const s = { ...DEFAULT_COUGH_SETTINGS };
  for (const r of rows) {
    const v = parseFloat(String(r.setting_value ?? '').trim());
    if (Number.isNaN(v)) continue;
    if (r.setting_key === 'audio_threshold') {
      const t = v > 1 ? v / 100 : v;
      if (t >= 0.3 && t <= 0.95) s.threshold = t;
    } else if (r.setting_key === 'audio_min_db' && v >= 30 && v <= 90) {
      s.minDb = v;
    } else if (r.setting_key === 'cough_alert_min' && Math.trunc(v) >= 1 && Math.trunc(v) <= 10) {
      s.alertMin = Math.trunc(v);
    } else if (r.setting_key === 'audio_ref_db' && v >= -30 && v <= -6) {
      s.refDb = v;
    }
  }
  return s;
}

// ---------------------------------------------------------------------
// Log-mel spectrogram (same as torchaudio MelSpectrogram + AmplitudeToDB)
// ---------------------------------------------------------------------
const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);

const N_BINS = N_FFT / 2 + 1;
const MEL_FB: Float64Array = (() => {
  // [N_BINS x N_MELS]
  const fb = new Float64Array(N_BINS * N_MELS);
  const allFreqs = Array.from({ length: N_BINS }, (_, i) => (i * (SAMPLE_RATE / 2)) / (N_BINS - 1));
  const mMin = hzToMel(0);
  const mMax = hzToMel(SAMPLE_RATE / 2);
  const fPts = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (N_MELS + 1)));
  for (let b = 0; b < N_BINS; b++) {
    for (let m = 0; m < N_MELS; m++) {
      const down = -(fPts[m] - allFreqs[b]) / (fPts[m + 1] - fPts[m]);
      const up = (fPts[m + 2] - allFreqs[b]) / (fPts[m + 2] - fPts[m + 1]);
      fb[b * N_MELS + m] = Math.max(0, Math.min(down, up));
    }
  }
  return fb;
})();

const HANN = Float64Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT));

// radix-2 FFT, in place
const BITREV = (() => {
  const r = new Uint32Array(N_FFT);
  const bits = Math.log2(N_FFT);
  for (let i = 0; i < N_FFT; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    r[i] = y;
  }
  return r;
})();
const COS = Float64Array.from({ length: N_FFT / 2 }, (_, i) => Math.cos((-2 * Math.PI * i) / N_FFT));
const SIN = Float64Array.from({ length: N_FFT / 2 }, (_, i) => Math.sin((-2 * Math.PI * i) / N_FFT));

function fftPower(frame: Float64Array, out: Float64Array) {
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) re[BITREV[i]] = frame[i];
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1;
    const step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step];
        const wi = SIN[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let i = 0; i < N_BINS; i++) out[i] = re[i] * re[i] + im[i] * im[i];
}

/** 1s waveform -> [1, 1, 64, 32] log-mel */
export function waveformToSpectrogram(chunk: ArrayLike<number>): Float32Array {
  const x = new Float64Array(SAMPLE_RATE);
  const n = Math.min(chunk.length, SAMPLE_RATE);
  for (let i = 0; i < n; i++) x[i] = chunk[i];
  // reflect pad (numpy mode="reflect")
  const pad = N_FFT / 2;
  const xp = new Float64Array(SAMPLE_RATE + 2 * pad);
  for (let i = 0; i < pad; i++) xp[i] = x[pad - i];
  xp.set(x, pad);
  for (let i = 0; i < pad; i++) xp[pad + SAMPLE_RATE + i] = x[SAMPLE_RATE - 2 - i];

  const out = new Float32Array(N_MELS * N_FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  for (let t = 0; t < N_FRAMES; t++) {
    const off = t * HOP;
    for (let i = 0; i < N_FFT; i++) frame[i] = xp[off + i] * HANN[i];
    fftPower(frame, power);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      for (let b = 0; b < N_BINS; b++) s += MEL_FB[b * N_MELS + m] * power[b];
      out[m * N_FRAMES + t] = 10 * Math.log10(Math.max(s, 1e-10));
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Helpers (same as app.py)
// ---------------------------------------------------------------------
function rmsOf(x: ArrayLike<number>, a = 0, b = x.length) {
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

export function dbLevel(chunk: ArrayLike<number>) {
  const rms = rmsOf(chunk);
  if (rms <= 1e-7) return 30;
  return Math.max(35, Math.min(105, Math.round((20 * Math.log10(rms) + 94) * 10) / 10));
}

function percentile(values: number[], q: number) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = ((s.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function levelTo(chunk: Float32Array, refDb: number, offsetDb = 0): Float32Array {
  const rms = rmsOf(chunk);
  if (rms < 1e-6) return chunk;
  let gain = 10 ** ((refDb + offsetDb) / 20) / rms;
  let peak = 0;
  for (let i = 0; i < chunk.length; i++) peak = Math.max(peak, Math.abs(chunk[i]));
  if (peak * gain > 0.99) gain = 0.99 / peak;
  const out = new Float32Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] * gain;
  return out;
}

function envelopeDb(x: Float32Array): number[] {
  const n = Math.floor(x.length / ENV_FRAME);
  const env: number[] = [];
  for (let f = 0; f < n; f++) env.push(20 * Math.log10(rmsOf(x, f * ENV_FRAME, (f + 1) * ENV_FRAME) + 1e-9));
  return env;
}

function coughShape(seg: Float32Array): CoughShape {
  const env = envelopeDb(seg);
  const mid = Math.floor(env.length / 2);
  const lo = Math.max(0, mid - 5);
  const hi = Math.min(env.length, mid + 6);
  let p = lo;
  for (let i = lo; i < hi; i++) if (env[i] > env[p]) p = i;
  const peak = env[p];
  const floor = percentile(env, 20);
  const prom = peak - floor;
  const onLevel = peak - Math.min(15, 0.8 * Math.max(prom, 0));
  let i = p;
  while (i > 0 && env[i - 1] >= onLevel) i--;
  const riseMs = ((p - i) * ENV_FRAME * 1000) / SAMPLE_RATE;
  let a = p;
  let b = p;
  while (a > 0 && env[a - 1] >= peak - 10) a--;
  while (b < env.length - 1 && env[b + 1] >= peak - 10) b++;
  const durMs = ((b - a + 1) * ENV_FRAME * 1000) / SAMPLE_RATE;
  const reasons: string[] = [];
  if (prom < COUGH_PROMINENCE_DB)
    reasons.push(`not sharp enough (${prom.toFixed(1)} dB above surroundings, need ${COUGH_PROMINENCE_DB})`);
  if (riseMs > COUGH_RISE_MAX_MS) reasons.push(`slow start (${riseMs.toFixed(0)} ms, cough < ${COUGH_RISE_MAX_MS} ms)`);
  if (durMs < COUGH_DUR_MIN_MS) reasons.push(`too short (${durMs.toFixed(0)} ms)`);
  if (durMs > COUGH_DUR_MAX_MS) reasons.push(`too long (${durMs.toFixed(0)} ms, cough < ${COUGH_DUR_MAX_MS} ms)`);
  return {
    ok: reasons.length === 0,
    prominenceDb: Math.round(prom * 10) / 10,
    riseMs: Math.round(riseMs),
    durationMs: Math.round(durMs),
    peakOffset: (p - mid) * ENV_FRAME,
    reasons,
  };
}

function candidatePeaks(chunk: Float32Array, endAbs: number, maxPeaks = 3): number[] {
  const env = envelopeDb(chunk);
  if (env.length === 0) return [];
  const floor = percentile(env, 20);
  const top = Math.max(...env);
  const gap = Math.trunc((COUGH_DEDUP_S * SAMPLE_RATE) / ENV_FRAME);
  const order = env.map((_, i) => i).sort((x, y) => env[y] - env[x] || x - y);
  const picked: number[] = [];
  for (const f of order) {
    if (picked.length >= maxPeaks || env[f] < Math.max(top - 20, floor + 6)) break;
    if ((f > 0 && env[f - 1] > env[f]) || (f < env.length - 1 && env[f + 1] > env[f])) continue;
    if (picked.every((q) => Math.abs(f - q) >= gap)) picked.push(f);
  }
  if (picked.length === 0) picked.push(order[0]);
  const start = endAbs - chunk.length;
  return picked.sort((x, y) => x - y).map((f) => start + f * ENV_FRAME + ENV_FRAME / 2);
}

// ---------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------
export const AUDIO_MODEL_URL = '/models/pig_audio.onnx';
let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function loadAudioModel(onProgress?: (loaded: number, total: number) => void) {
  sessionPromise ??= (async () => {
    const res = await fetch(AUDIO_MODEL_URL);
    if (!res.ok) throw new Error(`Audio model not found (${res.status}) at ${AUDIO_MODEL_URL}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let bytes: Uint8Array;
    if (res.body && onProgress) {
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.length;
        onProgress(loaded, total);
      }
      bytes = new Uint8Array(loaded);
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  })().catch((e) => {
    sessionPromise = null;
    throw e;
  });
  return sessionPromise;
}

async function rawProbs(session: ort.InferenceSession, chunk: Float32Array): Promise<number[]> {
  const input = new ort.Tensor('float32', waveformToSpectrogram(chunk), [1, 1, N_MELS, N_FRAMES]);
  const out = await session.run({ [session.inputNames[0]]: input });
  const logits = out[session.outputNames[0]].data as Float32Array;
  return Array.from(logits, (v) => 1 / (1 + Math.exp(-v)));
}

// ---------------------------------------------------------------------
// Whole-file analysis (= analyze_samples in app.py)
// ---------------------------------------------------------------------
export async function analyzeAudio(
  session: ort.InferenceSession,
  input: Float32Array,
  st: CoughSettings,
  onProgress?: (p: number) => void,
): Promise<AnalysisResult> {
  const x = input.length >= SAMPLE_RATE ? input : (() => {
    const z = new Float32Array(SAMPLE_RATE);
    z.set(input);
    return z;
  })();
  const padded = new Float32Array(x.length + 2 * COUGH_PAD);
  padded.set(x, COUGH_PAD);
  const get = (a: number, b: number) => padded.subarray(a + COUGH_PAD, b + COUGH_PAD);

  const support = Math.max(0.3, st.threshold - 0.2);
  const levels: number[] = [];
  const windows: WindowResult[] = [];
  const pending: number[] = [];
  const hop = SAMPLE_RATE / 2;
  const dedup = Math.trunc(COUGH_DEDUP_S * SAMPLE_RATE);
  const nWin = Math.floor((x.length - SAMPLE_RATE) / hop) + 1;

  let w = 0;
  for (let end = SAMPLE_RATE; end <= x.length; end += hop, w++) {
    const chunk = x.subarray(end - SAMPLE_RATE, end);
    const level = dbLevel(chunk);
    const bg = levels.length >= 20 ? percentile(levels, 20) : null;
    const gate = bg === null ? st.minDb : Math.max(st.minDb, Math.min(bg, AUDIO_BG_MAX_DB) + AUDIO_ABOVE_BG_DB);
    levels.push(level);
    if (levels.length > 240) levels.shift();
    const t = (end - SAMPLE_RATE) / SAMPLE_RATE;
    if (st.useGate && level < gate) {
      windows.push({ t, level, quiet: true, probs: null });
    } else {
      const probs = await rawProbs(session, levelTo(new Float32Array(chunk), st.refDb));
      windows.push({ t, level, quiet: false, probs });
      if (probs[0] >= support) {
        for (const pk of candidatePeaks(new Float32Array(chunk), end)) {
          if (pending.every((q) => Math.abs(pk - q) >= dedup)) pending.push(pk);
        }
      }
    }
    onProgress?.((0.6 * (w + 1)) / nWin);
    if (w % 8 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
  }

  // Careful 9-check look at every candidate
  const done: number[] = [];
  const coughs: CoughCheck[] = [];
  const rejected: CoughCheck[] = [];
  for (let k = 0; k < pending.length; k++) {
    let peak = pending[k];
    let shape = coughShape(get(peak - SAMPLE_RATE / 2, peak + SAMPLE_RATE / 2));
    peak += shape.peakOffset;
    if (shape.peakOffset) shape = coughShape(get(peak - SAMPLE_RATE / 2, peak + SAMPLE_RATE / 2));
    const acc = new Array(AUDIO_CLASSES.length).fill(0);
    let n = 0;
    for (const sh of COUGH_SHIFTS_S) {
      const c = peak + Math.trunc(sh * SAMPLE_RATE);
      const seg = new Float32Array(get(c - SAMPLE_RATE / 2, c + SAMPLE_RATE / 2));
      for (const off of LEVEL_SET_DB) {
        const p = await rawProbs(session, levelTo(seg, st.refDb, off));
        p.forEach((v, i) => (acc[i] += v));
        n++;
      }
    }
    const avg = acc.map((v) => v / n);
    const score = avg[0];
    let otherI = 1;
    for (let i = 2; i < avg.length; i++) if (avg[i] > avg[otherI]) otherI = i;
    const margin = score - avg[otherI];
    const reasons: string[] = [];
    if (score < st.threshold)
      reasons.push(`cough score ${(score * 100).toFixed(0)}% < threshold ${(st.threshold * 100).toFixed(0)}%`);
    if (margin < COUGH_MARGIN) reasons.push(`too close to ${AUDIO_CLASSES[otherI]} (${(avg[otherI] * 100).toFixed(0)}%)`);
    reasons.push(...shape.reasons);
    const r: CoughCheck = {
      ok: reasons.length === 0, peak, time: peak / SAMPLE_RATE, score, margin, probs: avg, shape, reasons,
    };
    if (done.every((q) => Math.abs(r.peak - q) >= dedup)) (r.ok ? coughs : rejected).push(r);
    done.push(r.peak, pending[k]);
    onProgress?.(0.6 + (0.4 * (k + 1)) / pending.length);
    await new Promise((res) => setTimeout(res, 0));
  }
  coughs.sort((a, b) => a.peak - b.peak);
  rejected.sort((a, b) => a.peak - b.peak);
  onProgress?.(1);
  const quiet = windows.filter((v) => v.quiet).length;
  return {
    windows,
    coughs,
    rejected,
    verdict: coughs.length ? 'COUGH' : 'NO COUGH',
    attention: coughs.length >= st.alertMin,
    quietShare: windows.length ? quiet / windows.length : 0,
    duration: input.length / SAMPLE_RATE,
  };
}

// ---------------------------------------------------------------------
// Any browser-playable file (wav / mp3 / m4a / ogg / webm) -> 16 kHz mono
// ---------------------------------------------------------------------
export async function decodeTo16kMono(file: Blob): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const probe = new Ctx(1, 1, 44100);
  const decoded = await probe.decodeAudioData(buf);
  // mix to mono
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / decoded.numberOfChannels;
  }
  if (decoded.sampleRate === SAMPLE_RATE) return mono;
  // resample with the browser's own resampler
  const frames = Math.ceil((decoded.length * SAMPLE_RATE) / decoded.sampleRate);
  const ctx = new Ctx(1, frames, SAMPLE_RATE);
  const src = ctx.createBufferSource();
  const b = ctx.createBuffer(1, mono.length, decoded.sampleRate);
  b.copyToChannel(mono, 0);
  src.buffer = b;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return new Float32Array(out.getChannelData(0));
}
