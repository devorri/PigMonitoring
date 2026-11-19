import React, { useEffect, useRef, useState } from 'react';
import * as ort from 'onnxruntime-web';
import type { AudioDetection, SensorLog, SmsLog, SystemSetting } from '../types';
import { SMS_TYPE_LABEL } from '../lib/sms';
import { PI_OFFLINE_AFTER_S, parseRelayState, settingNumber, settingValue } from '../lib/settingsSpec';
import { 
  Thermometer, 
  Volume2, 
  Activity, 
  Play, 
  Pause, 
  VolumeX, 
  Layers, 
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Camera,
  Video,
  Upload,
  Lightbulb,
  Droplets,
  Power,
  HeartPulse,
} from 'lucide-react';

const SUPABASE_PUBLIC_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rembfnigpvtuxoyjjexf.supabase.co';
// The Raspberry Pi (pi/app.py) gets frames from the ESP32-CAM over USB, runs YOLO + tracking,
// then uploads snap/live_0.jpg / live_1.jpg (alternating) and snap/live.json (newest image + detections)
const LIVE_STORAGE_BASE = `${SUPABASE_PUBLIC_URL}/storage/v1/object/public/snap`;
const LIVE_JSON_URL = `${LIVE_STORAGE_BASE}/live.json`;
const LIVE_CAMERA_FEED_URL = `${LIVE_STORAGE_BASE}/live_0.jpg?t=${Date.now()}`;
const LIVE_REFRESH_MS = 2000;
const LIVE_STALE_MS = 30000; // no new frame from the Pi for 30s -> show "AI offline"
// Browser model is only used for the PC Webcam / uploaded Video modes now
const PIG_MODEL_URL = '/models/best.onnx';

interface PiLiveFrame {
  t: number;              // ms timestamp when the Pi processed the frame
  image: string;          // live_0.jpg or live_1.jpg
  width: number;
  height: number;
  infer_ms: number;
  detections: TrackedPig[];
}

export interface TrackedPig {
  id: number;
  label: string;
  score: number;
  bbox: [number, number, number, number]; // [left, top, width, height] normalized
  isMoving: boolean;
  displacement: number;
  stillCount: number;
}

interface DashboardOverviewProps {
  logs: SensorLog[];
  settings: SystemSetting[];
  audioDetections: AudioDetection[];
  smsLogs: SmsLog[];
  section: 'overview' | 'controls' | 'camera';
  onNavigateLogs: () => void;
  onNavigateSettings: () => void;
  onUpdateSetting?: (key: string, value: string) => void;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  logs,
  settings,
  audioDetections,
  smsLogs,
  section,
  onNavigateLogs,
  onUpdateSetting,
}) => {
  // No logs yet -> show empty values, never made-up numbers
  const latestLog: SensorLog = logs[0] || {
    id: 0,
    created_at: new Date().toISOString(),
    ambient_temp: null,
    floor_temp: null,
    motion_detected: null,
    audio_level: null,
    image_url: null,
    audio_url: null,
  };

  const formatTemp = (val: number | null | undefined, fallback = '--'): string => {
    if (val == null || isNaN(Number(val))) return fallback;
    return Number(val).toFixed(1);
  };

  // Exactly the dB the Pi saved (null = no reading). For bar heights use ?? 0.
  const cleanAudioLevel = (val: number | null | undefined): number | null => {
    if (val == null || isNaN(Number(val))) return null;
    return Math.round(Number(val));
  };
  const fmtDb = (val: number | null) => (val == null ? '--' : String(val));

  // 1s clock for "x min ago" and the heat protection countdown
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ambientTempNum = latestLog.ambient_temp != null && !isNaN(Number(latestLog.ambient_temp))
    ? Number(latestLog.ambient_temp)
    : null;

  const floorTempNum = latestLog.floor_temp != null && !isNaN(Number(latestLog.floor_temp))
    ? Number(latestLog.floor_temp)
    : null;

  const latestAudio = cleanAudioLevel(latestLog.audio_level);

  // Every threshold / mode comes from the shared settings spec = the values the Pi is using
  const solenoidTriggerTemp = settingNumber(settings, 'solenoid_trigger_temp');
  const lowTempThreshold = settingNumber(settings, 'temp_threshold_low');
  const noiseThreshold = settingNumber(settings, 'noise_alert_level');
  const bulbMode = settingValue(settings, 'bulb_mode');
  const solenoidMode = settingValue(settings, 'solenoid_mode');
  const bulbStartHour = settingNumber(settings, 'bulb_start_hour');
  const bulbEndHour = settingNumber(settings, 'bulb_end_hour');
  const fmtHour = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;

  const peakNow = [ambientTempNum, floorTempNum].filter((t): t is number => t !== null);
  const peakTempNum = peakNow.length ? Math.max(...peakNow) : null;
  // High = the Pi's heat protection trigger (hottest of ambient / floor), exactly like the Pi
  const isHighTemp = peakTempNum !== null && peakTempNum >= solenoidTriggerTemp;
  const isLowTemp = ambientTempNum !== null && ambientTempNum < lowTempThreshold;
  const isHighNoise = latestAudio !== null && latestAudio > noiseThreshold;

  // Latest audio AI result from the Pi (audio_detections)
  const latestDet = audioDetections[0] ?? null;
  const detAgeMin = latestDet ? Math.max(0, Math.round((nowSec * 1000 - new Date(latestDet.created_at).getTime()) / 60000)) : null;
  const detFresh = detAgeMin !== null && detAgeMin <= 10;
  const isAudioAttention = detFresh && latestDet?.status === 'ATTENTION NEEDED';

  const currentHour = new Date().getHours();
  const isNightSchedule = currentHour >= bulbStartHour || currentHour < bulbEndHour;

  const currentMaxTemp = peakTempNum;

  // REAL relay state written by the Pi (system_settings.relay_state, JSON, every change + every 30s)
  const relayRaw = parseRelayState(settings);
  const piRelay = relayRaw && nowSec - relayRaw.t < PI_OFFLINE_AFTER_S ? relayRaw : null; // stale -> Pi offline
  const relayLive = piRelay !== null;
  const coolingPhase = piRelay?.phase ?? 'idle';
  const coolingLeft = piRelay ? Math.max(0, Math.round(piRelay.left - (nowSec - piRelay.t))) : 0;
  const fmtLeft = `${Math.floor(coolingLeft / 60)}:${String(coolingLeft % 60).padStart(2, '0')}`;

  // Estimate (only used when the Pi isn't reporting): heat protection works in auto AND off
  const estHeat = solenoidMode !== 'on' && currentMaxTemp !== null && currentMaxTemp >= solenoidTriggerTemp;
  const isSolenoidActive = relayLive ? piRelay.solenoid : solenoidMode === 'on' || estHeat;
  const isBulbActive = relayLive
    ? piRelay.bulb
    : !estHeat && (bulbMode === 'on' || (bulbMode === 'auto' && isNightSchedule));

  // Audio playback
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [audioError, setAudioError] = useState(false);

  const toggleAudioPlayback = () => {
    if (!latestLog.audio_url) return;
    const audioElement = document.getElementById('latest-pig-audio') as HTMLAudioElement;
    if (audioElement) {
      if (isPlayingAudio) {
        audioElement.pause();
        setIsPlayingAudio(false);
      } else {
        audioElement.play().then(() => setIsPlayingAudio(true)).catch(() => setAudioError(true));
      }
    }
  };

  // Chart data
  const chartLogs = [...logs].slice(0, 15).reverse();
  const allChartTemps = chartLogs
    .flatMap((l) => [
      l.ambient_temp != null && !isNaN(Number(l.ambient_temp)) ? Number(l.ambient_temp) : null,
      l.floor_temp != null && !isNaN(Number(l.floor_temp)) ? Number(l.floor_temp) : null,
    ])
    .filter((v): v is number => v !== null);

  const maxTemp = allChartTemps.length > 0 ? Math.max(...allChartTemps, 32) : 32;
  const minTemp = allChartTemps.length > 0 ? Math.min(...allChartTemps, 15) : 15;
  const tempRange = maxTemp - minTemp || 1;

  const svgWidth = 600;
  const svgHeight = 200;
  const padding = 40;

  const getX = (index: number) => {
    if (chartLogs.length <= 1) return padding;
    return padding + (index / (chartLogs.length - 1)) * (svgWidth - padding * 2);
  };

  const getY = (val: number) => {
    return svgHeight - padding - ((val - minTemp) / tempRange) * (svgHeight - padding * 2);
  };

  // Build smooth path
  const buildPath = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
    let d = `M ${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x},${points[i].y}`;
    }
    return d;
  };

  const ambientPts = chartLogs
    .map((l, i) => {
      const v = l.ambient_temp != null && !isNaN(Number(l.ambient_temp)) ? Number(l.ambient_temp) : null;
      return v !== null ? { x: getX(i), y: getY(v) } : null;
    })
    .filter((p): p is { x: number; y: number } => p !== null);

  const floorPts = chartLogs
    .map((l, i) => {
      const v = l.floor_temp != null && !isNaN(Number(l.floor_temp)) ? Number(l.floor_temp) : null;
      return v !== null ? { x: getX(i), y: getY(v) } : null;
    })
    .filter((p): p is { x: number; y: number } => p !== null);

  // Area fill path
  const buildAreaPath = (points: { x: number; y: number }[]) => {
    if (points.length < 2) return '';
    const linePath = buildPath(points);
    return `${linePath} L ${points[points.length - 1].x},${svgHeight - padding} L ${points[0].x},${svgHeight - padding} Z`;
  };

  // Y-axis labels
  const yLabels = [minTemp, minTemp + tempRange / 2, maxTemp].map(v => Math.round(v * 10) / 10);

  const [activeChartPoint, setActiveChartPoint] = useState<SensorLog | null>(null);
  const cameraImageRef = useRef<HTMLImageElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [feedMode, setFeedMode] = useState<'stream' | 'webcam' | 'video'>('stream');
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [cameraFeedUrl, setCameraFeedUrl] = useState<string>(LIVE_CAMERA_FEED_URL);
  const [pigDetections, setPigDetections] = useState<TrackedPig[]>([]);
  const previousTracksRef = useRef<TrackedPig[]>([]);
  const nextTrackIdRef = useRef<number>(1);
  const [aiStatus, setAiStatus] = useState<'loading' | 'ready' | 'blocked'>('loading');

  // Pen camera via the Raspberry Pi: read live.json, preload the image it points to,
  // then swap image + boxes together (no flicker, boxes always match the picture)
  useEffect(() => {
    if (feedMode !== 'stream') return;
    let cancelled = false;
    let lastFrameTime = 0;

    const refresh = async () => {
      try {
        const res = await fetch(`${LIVE_JSON_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const frame = (await res.json()) as PiLiveFrame;
        if (cancelled) return;

        const isStale = Date.now() - frame.t > LIVE_STALE_MS;
        if (frame.t === lastFrameTime) {
          if (isStale) setAiStatus('blocked');
          return;
        }
        lastFrameTime = frame.t;

        const nextUrl = `${LIVE_STORAGE_BASE}/${frame.image}?t=${frame.t}`;
        const preload = new Image();
        preload.crossOrigin = 'anonymous';
        preload.onload = () => {
          if (cancelled) return;
          setCameraFeedUrl(nextUrl);
          setPigDetections(Array.isArray(frame.detections) ? frame.detections : []);
          setAiStatus(isStale ? 'blocked' : 'ready');
        };
        preload.src = nextUrl;
      } catch {
        if (!cancelled) {
          setPigDetections([]);
          setAiStatus('blocked');
        }
      }
    };
    refresh();
    const timer = window.setInterval(refresh, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [feedMode]);

  // Webcam stream management
  useEffect(() => {
    if (feedMode !== 'webcam') return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices?.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } })
      .then((s) => {
        stream = s;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = s;
          cameraVideoRef.current.play().catch(() => {});
        }
      })
      .catch((err) => {
        console.warn('Webcam access was not granted or unavailable:', err);
        setFeedMode('stream');
      });

    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = null;
      }
    };
  }, [feedMode]);

  // Browser YOLO: only for the PC Webcam / uploaded Video modes.
  // The pen camera ("Pen" mode) is analyzed on the Raspberry Pi.
  useEffect(() => {
    if (feedMode === 'stream') return;
    let cancelled = false;
    let detecting = false;
    let session: ort.InferenceSession | null = null;
    let clearedOldBoxes = false;
    previousTracksRef.current = [];

    const intersectionOverUnion = (
      first: [number, number, number, number],
      second: [number, number, number, number]
    ) => {
      const left = Math.max(first[0], second[0]);
      const top = Math.max(first[1], second[1]);
      const right = Math.min(first[0] + first[2], second[0] + second[2]);
      const bottom = Math.min(first[1] + first[3], second[1] + second[3]);
      const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
      const union = first[2] * first[3] + second[2] * second[3] - overlap;
      return union ? overlap / union : 0;
    };

    const detectPigs = async () => {
      let mediaSource: CanvasImageSource | null = null;
      if (feedMode === 'webcam' || (feedMode === 'video' && uploadedVideoUrl)) {
        const vid = cameraVideoRef.current;
        if (vid && vid.readyState >= 2 && !vid.paused && !vid.ended) {
          mediaSource = vid;
        }
      }

      if (!mediaSource) {
        // Clear boxes left over from the previous mode until this source is ready
        if (!clearedOldBoxes && !cancelled) {
          clearedOldBoxes = true;
          setPigDetections([]);
          setAiStatus('loading');
        }
        return;
      }
      if (detecting) return;

      detecting = true;
      try {
        session ??= await ort.InferenceSession.create(PIG_MODEL_URL, {
          executionProviders: ['wasm'],
        });

        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 640;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable');

        context.drawImage(mediaSource, 0, 0, 640, 640);
        const pixels = context.getImageData(0, 0, 640, 640).data;
        const input = new Float32Array(3 * 640 * 640);

        for (let pixel = 0; pixel < 640 * 640; pixel += 1) {
          input[pixel] = pixels[pixel * 4] / 255;
          input[640 * 640 + pixel] = pixels[pixel * 4 + 1] / 255;
          input[2 * 640 * 640 + pixel] = pixels[pixel * 4 + 2] / 255;
        }

        const output = await session.run({
          [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 640, 640]),
        });
        const result = output[session.outputNames[0]];
        const values = result.data as Float32Array;
        const dims = result.dims; // e.g. [1, 6, 8400] for YOLOv8
        const candidates: { bbox: [number, number, number, number]; score: number; label: string }[] = [];

        if (dims && dims.length === 3 && dims[1] === 6) {
          // YOLOv8 format: [1, 6, 8400]
          const numAnchors = dims[2];
          for (let i = 0; i < numAnchors; i += 1) {
            const scorePig = values[4 * numAnchors + i];
            const scorePiglet = values[5 * numAnchors + i];
            const maxScore = Math.max(scorePig, scorePiglet);
            if (maxScore < 0.25) continue;

            const label = scorePig >= scorePiglet ? 'Pig' : 'Piglet';
            const cx = values[0 * numAnchors + i];
            const cy = values[1 * numAnchors + i];
            const w = values[2 * numAnchors + i];
            const h = values[3 * numAnchors + i];

            const left = Math.max(0, (cx - w / 2) / 640);
            const top = Math.max(0, (cy - h / 2) / 640);
            const width = Math.min(1 - left, w / 640);
            const height = Math.min(1 - top, h / 640);

            candidates.push({
              score: maxScore,
              label,
              bbox: [left, top, width, height],
            });
          }
        } else {
          // Transposed [1, 8400, 6] or legacy [1, 25200, 6]
          const numBoxes = Math.floor(values.length / 6);
          for (let index = 0; index < numBoxes; index += 1) {
            const offset = index * 6;
            const scorePig = values[offset + 4];
            const scorePiglet = values[offset + 5];
            const maxScore = Math.max(scorePig, scorePiglet);
            if (maxScore < 0.25) continue;

            const label = scorePig >= scorePiglet ? 'Pig' : 'Piglet';
            const cx = values[offset];
            const cy = values[offset + 1];
            const w = values[offset + 2];
            const h = values[offset + 3];

            const left = Math.max(0, (cx - w / 2) / 640);
            const top = Math.max(0, (cy - h / 2) / 640);
            const width = Math.min(1 - left, w / 640);
            const height = Math.min(1 - top, h / 640);

            candidates.push({
              score: maxScore,
              label,
              bbox: [left, top, width, height],
            });
          }
        }

        const selected: typeof candidates = [];
        for (const candidate of candidates.sort((first, second) => second.score - first.score)) {
          if (selected.every((existing) => intersectionOverUnion(existing.bbox, candidate.bbox) < 0.45)) {
            selected.push(candidate);
          }
          if (selected.length >= 25) break;
        }

        // --- Multi-Pig Movement & Spatial Tracking Algorithm ---
        const prevTracks = previousTracksRef.current;
        const trackedPigs: TrackedPig[] = [];
        const matchedPrevIndices = new Set<number>();

        for (const candidate of selected) {
          const currCenter = {
            x: candidate.bbox[0] + candidate.bbox[2] / 2,
            y: candidate.bbox[1] + candidate.bbox[3] / 2,
          };

          let bestMatchIdx = -1;
          let bestDist = Infinity;

          for (let pIdx = 0; pIdx < prevTracks.length; pIdx++) {
            if (matchedPrevIndices.has(pIdx)) continue;
            const prev = prevTracks[pIdx];
            const prevCenter = {
              x: prev.bbox[0] + prev.bbox[2] / 2,
              y: prev.bbox[1] + prev.bbox[3] / 2,
            };
            const d = Math.hypot(currCenter.x - prevCenter.x, currCenter.y - prevCenter.y);
            const iou = intersectionOverUnion(candidate.bbox, prev.bbox);

            if ((iou > 0.2 || d < 0.15) && d < bestDist) {
              bestDist = d;
              bestMatchIdx = pIdx;
            }
          }

          if (bestMatchIdx !== -1) {
            matchedPrevIndices.add(bestMatchIdx);
            const prevPig = prevTracks[bestMatchIdx];
            const displacement = bestDist;
            
            // Movement threshold: displacement > 0.012 in normalized frame space
            const movedSignificantly = displacement > 0.012;
            const newStillCount = movedSignificantly ? 0 : prevPig.stillCount + 1;
            const isMoving = newStillCount < 2; // still for 2 consecutive cycles means resting

            trackedPigs.push({
              id: prevPig.id,
              label: candidate.label,
              score: candidate.score,
              bbox: candidate.bbox,
              isMoving,
              displacement,
              stillCount: newStillCount,
            });
          } else {
            const newId = nextTrackIdRef.current++;
            if (nextTrackIdRef.current > 999) nextTrackIdRef.current = 1;

            trackedPigs.push({
              id: newId,
              label: candidate.label,
              score: candidate.score,
              bbox: candidate.bbox,
              isMoving: true,
              displacement: 0,
              stillCount: 0,
            });
          }
        }

        previousTracksRef.current = trackedPigs;

        if (cancelled) return;
        setPigDetections(trackedPigs);
        setAiStatus('ready');
      } catch {
        if (!cancelled) setAiStatus('blocked');
      } finally {
        detecting = false;
      }
    };

    detectPigs();
    const timer = window.setInterval(detectPigs, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [feedMode, uploadedVideoUrl]);

  // Prev log comparison
  const prevLog = logs[1];
  const prevAmbient = prevLog?.ambient_temp != null && !isNaN(Number(prevLog.ambient_temp))
    ? Number(prevLog.ambient_temp)
    : null;
  const prevAudio = cleanAudioLevel(prevLog?.audio_level);

  const tempDiff = ambientTempNum !== null && prevAmbient !== null
    ? +(ambientTempNum - prevAmbient).toFixed(1)
    : 0;
  const audioDiff = prevAudio !== null && latestAudio !== null
    ? latestAudio - prevAudio
    : 0;

  const movingPigs = pigDetections.filter((d) => d.isMoving);
  const restingPigs = pigDetections.filter((d) => !d.isMoving);
  const herdActivityRate = pigDetections.length > 0
    ? Math.round((movingPigs.length / pigDetections.length) * 100)
    : 0;

  return (
    <div className="dashboard-overview">
      {/* Status line: the one thing to read first */}
      {section === 'overview' && (() => {
        const ago = (iso: string) => {
          const m = Math.max(0, Math.round((nowSec * 1000 - new Date(iso).getTime()) / 60000));
          return m === 0 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
        };
        let tone: 'ok' | 'warn' | 'alert' | 'idle' = 'ok';
        let title = 'All good in the pen';
        let detail = logs.length
          ? `Ambient ${formatTemp(ambientTempNum)}°C, floor ${formatTemp(floorTempNum)}°C, noise ${fmtDb(latestAudio)} dB. Last reading ${ago(latestLog.created_at)}.`
          : '';
        if (!logs.length) {
          tone = 'idle';
          title = 'Waiting for the first reading';
          detail = 'Readings appear here as soon as the Raspberry Pi starts sending them.';
        } else if (coolingPhase === 'spraying') {
          tone = 'alert';
          title = 'Cooling the pen';
          detail = `Heat ${piRelay?.temp ?? formatTemp(peakTempNum)}°C reached the ${solenoidTriggerTemp}°C limit. Water is on, ${fmtLeft} left in cycle ${piRelay?.cycle}.`;
        } else if (coolingPhase === 'waiting') {
          tone = 'warn';
          title = 'Checking if the pen cooled down';
          detail = `Water paused after cycle ${piRelay?.cycle}. Re-checking the temperature in ${fmtLeft}.`;
        } else if (isHighTemp) {
          tone = 'alert';
          title = 'It is too hot in the pen';
          detail = `${formatTemp(peakTempNum)}°C is at or above the ${solenoidTriggerTemp}°C limit. Heat protection turns the water on.`;
        } else if (isAudioAttention) {
          tone = 'warn';
          title = (latestDet?.cough_events ?? 0) > 0 ? 'Coughing heard in the pen' : 'Stress sounds heard in the pen';
          detail = `${latestDet?.cough_events} cough and ${latestDet?.stress_events} stress sounds, ${ago(latestDet!.created_at)}. Listen to the clip in Sound.`;
        } else if (isLowTemp) {
          tone = 'warn';
          title = 'The pen is getting cold';
          detail = `Ambient ${formatTemp(ambientTempNum)}°C is below ${lowTempThreshold}°C.`;
        } else if (isHighNoise) {
          tone = 'warn';
          title = 'It is loud in the pen';
          detail = `Noise ${fmtDb(latestAudio)} dB is above ${noiseThreshold} dB.`;
        }
        return (
          <section className={`status-hero tone-${tone}`}>
            <span className="status-hero-dot" aria-hidden="true" />
            <div>
              <h2 className="status-hero-title">{title}</h2>
              {detail && <p className="status-hero-detail">{detail}</p>}
            </div>
            <span className={`status-hero-pi ${relayLive ? 'on' : 'off'}`}>{relayLive ? 'Pi online' : 'Pi offline'}</span>
          </section>
        );
      })()}

      {section === 'overview' && (
        <>
      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon-circle pink">
              <Thermometer style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Ambient</span>
          </div>
          <div className="kpi-value-row">
            <span className="kpi-value">{formatTemp(ambientTempNum)}</span>
            <span className="kpi-unit">°C</span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${ambientTempNum === null ? 'neutral' : ambientTempNum >= solenoidTriggerTemp ? 'red' : isLowTemp ? 'amber' : 'green'}`}>
              {ambientTempNum === null ? 'No data' : ambientTempNum >= solenoidTriggerTemp ? `≥ ${solenoidTriggerTemp}°C heat` : isLowTemp ? 'Below threshold' : 'Normal'}
            </span>
            {tempDiff !== 0 && (
              <span className={`kpi-trend ${tempDiff > 0 ? 'up' : 'down'}`}>
                {tempDiff > 0 ? <TrendingUp style={{ width: 12, height: 12 }} /> : <TrendingDown style={{ width: 12, height: 12 }} />}
                {Math.abs(tempDiff)}°
              </span>
            )}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon-circle amber">
              <Layers style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Floor</span>
          </div>
          <div className="kpi-value-row">
            <span className="kpi-value">{formatTemp(floorTempNum)}</span>
            <span className="kpi-unit">°C</span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${floorTempNum === null ? 'neutral' : floorTempNum >= solenoidTriggerTemp ? 'red' : 'neutral'}`}>
              {floorTempNum === null
                ? 'No data'
                : floorTempNum >= solenoidTriggerTemp
                ? `≥ ${solenoidTriggerTemp}°C heat`
                : ambientTempNum !== null
                ? `${(ambientTempNum - floorTempNum).toFixed(1)}° difference`
                : 'Normal'}
            </span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon-circle indigo">
              <Volume2 style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Noise</span>
          </div>
          <div className="kpi-value-row">
            <span className="kpi-value">{fmtDb(latestAudio)}</span>
            <span className="kpi-unit">dB</span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${latestAudio === null ? 'neutral' : isHighNoise ? 'red' : 'green'}`}>
              {latestAudio === null ? 'No data' : isHighNoise ? 'High noise' : 'Quiet'}
            </span>
            {audioDiff !== 0 && (
              <span className={`kpi-trend ${audioDiff > 0 ? 'up' : 'down'}`}>
                {audioDiff > 0 ? <TrendingUp style={{ width: 12, height: 12 }} /> : <TrendingDown style={{ width: 12, height: 12 }} />}
                {Math.abs(audioDiff)}
              </span>
            )}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className={`kpi-icon-circle ${latestLog.motion_detected ? 'green' : 'slate'}`}>
              <Activity style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Motion</span>
          </div>
          <div className="kpi-value-row">
            <span className={`kpi-value-text ${latestLog.motion_detected ? 'active' : 'idle'}`}>
              {latestLog.motion_detected == null ? 'No data' : latestLog.motion_detected ? 'Active' : 'Resting'}
            </span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${latestLog.motion_detected ? 'green' : 'neutral'}`}>
              {latestLog.motion_detected == null ? 'No reading' : latestLog.motion_detected ? 'Movement detected' : 'No movement'}
            </span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className={`kpi-icon-circle ${!latestDet ? 'slate' : latestDet.status === 'ATTENTION NEEDED' ? 'pink' : 'green'}`}>
              <HeartPulse style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Sound</span>
          </div>
          <div className="kpi-value-row">
            <span className={`kpi-value-text ${latestDet?.status === 'ATTENTION NEEDED' ? 'active' : 'idle'}`}>
              {!latestDet ? 'No data' : latestDet.status === 'ATTENTION NEEDED' ? 'Attention' : 'Healthy'}
            </span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${!latestDet ? 'neutral' : latestDet.status === 'ATTENTION NEEDED' ? 'red' : 'green'}`}>
              {!latestDet
                ? 'Pi has not sent audio yet'
                : `${latestDet.cough_events} cough · ${latestDet.stress_events} stress`}
            </span>
            {latestDet && (
              <span className="kpi-trend" title={`${latestDet.top_class ?? ''} · ${new Date(latestDet.created_at).toLocaleString()}`}>
                {detAgeMin === 0 ? 'now' : `${detAgeMin}m ago`}
              </span>
            )}
          </div>
        </div>
      </div>
        </>
      )}

      {section === 'controls' && (
        <>
      {/* Actuator & Relay Controls */}
      <div className="relay-controls-section">
        <div className="relay-section-header">
          <div>
            <h3 className="relay-section-title">Relays</h3>
            <p className="relay-section-subtitle">Pick a mode for each relay. Heat protection always overrides at ≥{solenoidTriggerTemp}°C.</p>
          </div>
          <div className={`relay-sync-indicator ${relayLive ? '' : 'offline'}`}>
            <span className="pulse-dot"></span> {relayLive ? 'Pi online · live' : 'Pi offline · estimated'}
          </div>
        </div>

        <div className="relay-cards-grid">
          {/* Heating Bulb Card */}
          <div className={`relay-card ${isBulbActive ? 'active' : ''}`}>
            <div className="relay-card-main">
              <div className="relay-icon-col">
                <div className={`relay-icon-bubble ${isBulbActive ? 'active-amber' : ''}`}>
                  <Lightbulb style={{ width: 22, height: 22 }} />
                </div>
              </div>
              <div className="relay-info-col">
                <div className="relay-title-row">
                  <h4 className="relay-title">Heating bulb</h4>
                  <span className={`relay-status-pill ${isBulbActive ? 'on' : 'off'}`}>
                    <Power style={{ width: 12, height: 12 }} />
                    {isBulbActive ? 'On' : 'Off'}
                  </span>
                </div>
                <p className="relay-description">
                  {coolingPhase !== 'idle'
                    ? 'Forced OFF by heat protection while the pen cools down'
                    : bulbMode === 'auto'
                    ? `Auto: on from ${fmtHour(bulbStartHour)} to ${fmtHour(bulbEndHour)} (${isNightSchedule ? 'on now' : 'off now'})`
                    : bulbMode === 'on'
                    ? 'Always on'
                    : 'Always off'}
                  <br />
                  <small style={{ opacity: 0.7 }}>{relayLive ? '● Live from the Pi' : '○ Pi not reporting, estimated'}</small>
                </p>
                <div className="relay-actions-row">
                  <button
                    type="button"
                    className={`relay-mode-btn ${bulbMode === 'auto' ? 'active-auto' : ''}`}
                    onClick={() => onUpdateSetting?.('bulb_mode', 'auto')}
                  >
                    Auto
                  </button>
                  <button
                    type="button"
                    className={`relay-mode-btn ${bulbMode === 'on' ? 'active-on' : ''}`}
                    onClick={() => onUpdateSetting?.('bulb_mode', 'on')}
                  >
                    Always on
                  </button>
                  <button
                    type="button"
                    className={`relay-mode-btn ${bulbMode === 'off' ? 'active-off' : ''}`}
                    onClick={() => onUpdateSetting?.('bulb_mode', 'off')}
                  >
                    Always off
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Water Solenoid Card */}
          <div className={`relay-card ${isSolenoidActive ? 'active' : ''}`}>
            <div className="relay-card-main">
              <div className="relay-icon-col">
                <div className={`relay-icon-bubble ${isSolenoidActive ? 'active-blue' : ''}`}>
                  <Droplets style={{ width: 22, height: 22 }} />
                </div>
              </div>
              <div className="relay-info-col">
                <div className="relay-title-row">
                  <h4 className="relay-title">Water sprinkler</h4>
                  <span className={`relay-status-pill ${isSolenoidActive ? 'on-water' : 'off'}`}>
                    <Power style={{ width: 12, height: 12 }} />
                    {isSolenoidActive ? 'Spraying' : 'Closed'}
                  </span>
                </div>
                <p className="relay-description">
                  {coolingPhase === 'spraying'
                    ? `Heat protection is spraying: ${fmtLeft} left in cycle ${piRelay?.cycle}, peak ${piRelay?.temp ?? '--'}°C.`
                    : coolingPhase === 'waiting'
                    ? `Heat protection paused after cycle ${piRelay?.cycle}. Re-checking the temperature in ${fmtLeft}.`
                    : solenoidMode === 'on'
                    ? 'Always open'
                    : solenoidMode === 'off'
                    ? `Always closed, but heat protection still opens it at ≥ ${solenoidTriggerTemp}°C. Now ${currentMaxTemp !== null ? `${currentMaxTemp.toFixed(1)}°C` : 'no reading'}.`
                    : `Auto: sprays 10 min, checks for 2 min, repeats while ≥ ${solenoidTriggerTemp}°C. Now ${currentMaxTemp !== null ? `${currentMaxTemp.toFixed(1)}°C` : 'no reading'}.`}
                  <br />
                  <small style={{ opacity: 0.7 }}>{relayLive ? '● Live from the Pi' : '○ Pi not reporting, estimated'}</small>
                </p>
                <div className="relay-actions-row">
                  <button
                    type="button"
                    className={`relay-mode-btn ${solenoidMode === 'auto' ? 'active-auto' : ''}`}
                    onClick={() => onUpdateSetting?.('solenoid_mode', 'auto')}
                  >
                    Auto
                  </button>
                  <button
                    type="button"
                    className={`relay-mode-btn ${solenoidMode === 'on' ? 'active-on' : ''}`}
                    onClick={() => onUpdateSetting?.('solenoid_mode', 'on')}
                  >
                    Always open
                  </button>
                  <button
                    type="button"
                    className={`relay-mode-btn ${solenoidMode === 'off' ? 'active-off' : ''}`}
                    onClick={() => onUpdateSetting?.('solenoid_mode', 'off')}
                  >
                    Always closed
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
        </>
      )}

      {/* Overview: chart + recent events.  Camera page: camera. */}
      {section !== 'controls' && (
      <div className={`dashboard-grid-main ${section === 'camera' ? 'single' : ''}`}>
        {section === 'overview' && (
          <>
        {/* Temperature Chart */}
        <div className="dashboard-panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Temperature</h3>
              <p className="panel-subtitle">Last {chartLogs.length} readings</p>
            </div>
            <div className="chart-legend">
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#2f5d50' }}></span> Ambient
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#c08a2e' }}></span> Floor
              </span>
            </div>
          </div>

          {chartLogs.length < 2 && (
            <div className="chart-empty">
              {chartLogs.length === 0 ? 'No readings yet. The chart fills in as the Pi sends sensor logs.' : 'Waiting for one more reading to draw the trend…'}
            </div>
          )}
          <div
            className="chart-container"
            style={chartLogs.length < 2 ? { display: 'none' } : undefined}
            onMouseLeave={() => setActiveChartPoint(null)}
          >
            <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="telemetry-svg">
              {/* Y-axis labels */}
              {yLabels.map((label, i) => {
                const y = getY(label);
                return (
                  <g key={`ylabel-${i}`}>
                    <text x={padding - 8} y={y + 4} fill="#94a3b8" fontSize="10" textAnchor="end" fontWeight="500">
                      {label}°
                    </text>
                    <line x1={padding} y1={y} x2={svgWidth - padding} y2={y} stroke="#f1f5f9" strokeWidth="1" />
                  </g>
                );
              })}

              {/* Threshold line */}
              <line
                x1={padding} y1={getY(solenoidTriggerTemp)}
                x2={svgWidth - padding} y2={getY(solenoidTriggerTemp)}
                stroke="#fda4af" strokeDasharray="6 4" strokeWidth="1"
              />
              <text x={padding + 4} y={getY(solenoidTriggerTemp) - 6} fill="#fb7185" fontSize="9" textAnchor="start" fontWeight="600">
                {solenoidTriggerTemp}° heat protection
              </text>

              {/* Area fills */}
              <path d={buildAreaPath(ambientPts)} fill="url(#ambientGradient)" />
              <path d={buildAreaPath(floorPts)} fill="url(#floorGradient)" />

              {/* Gradients */}
              <defs>
                <linearGradient id="ambientGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2f5d50" stopOpacity="0.06" />
                  <stop offset="100%" stopColor="#2f5d50" stopOpacity="0.01" />
                </linearGradient>
                <linearGradient id="floorGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c08a2e" stopOpacity="0.08" />
                  <stop offset="100%" stopColor="#c08a2e" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* Lines */}
              <path d={buildPath(floorPts)} fill="none" stroke="#c08a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d={buildPath(ambientPts)} fill="none" stroke="#2f5d50" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

              {/* Data points */}
              {chartLogs.map((log, index) => {
                const cx = getX(index);
                const ambVal = log.ambient_temp != null && !isNaN(Number(log.ambient_temp)) ? Number(log.ambient_temp) : null;
                const flrVal = log.floor_temp != null && !isNaN(Number(log.floor_temp)) ? Number(log.floor_temp) : null;
                const cyAmbient = ambVal !== null ? getY(ambVal) : null;
                const cyFloor = flrVal !== null ? getY(flrVal) : null;
                const isSelected = activeChartPoint?.id === log.id;

                return (
                  <g key={log.id} className="chart-point-group" onMouseEnter={() => setActiveChartPoint(log)}>
                    {cyAmbient !== null && (
                      <circle cx={cx} cy={cyAmbient} r={isSelected ? 5 : 3} fill="#2f5d50" stroke="#fff" strokeWidth="2" />
                    )}
                    {cyFloor !== null && (
                      <circle cx={cx} cy={cyFloor} r={isSelected ? 4 : 2.5} fill="#c08a2e" stroke="#fff" strokeWidth="2" />
                    )}
                    {/* Invisible hover target */}
                    <rect x={cx - 15} y={padding} width={30} height={svgHeight - padding * 2} fill="transparent" />
                  </g>
                );
              })}
            </svg>

            {activeChartPoint && (
              <div className="chart-tooltip">
                <span className="tooltip-time">{new Date(activeChartPoint.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <div className="tooltip-row">
                  <span style={{ color: '#2f5d50', fontWeight: 600 }}>{formatTemp(activeChartPoint.ambient_temp)}°C</span>
                  <span style={{ color: '#c08a2e', fontWeight: 600 }}>{formatTemp(activeChartPoint.floor_temp)}°C</span>
                  <span style={{ color: '#64748b' }}>{fmtDb(cleanAudioLevel(activeChartPoint.audio_level))} dB</span>
                </div>
              </div>
            )}
          </div>

          {/* Audio bars */}
          <div className="audio-timeline-section">
            <div className="audio-timeline-header">
              <span className="audio-timeline-label">Noise</span>
              <span className="audio-timeline-avg">
                Avg: {(() => {
                  const v = chartLogs.map((l) => cleanAudioLevel(l.audio_level)).filter((x): x is number => x !== null);
                  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : '--';
                })()} dB
              </span>
            </div>
            {chartLogs.length === 0 && <div className="audio-bars-empty">No noise readings yet</div>}
            <div className="audio-bars-grid">
              {chartLogs.map((log) => {
                const audioLvl = cleanAudioLevel(log.audio_level) ?? 0;
                const isHigh = audioLvl > noiseThreshold;
                return (
                  <div
                    key={log.id}
                    className="audio-bar-wrapper"
                    title={`${new Date(log.created_at).toLocaleTimeString()}: ${audioLvl} dB`}
                  >
                    <div
                      className={`audio-bar ${isHigh ? 'spike' : ''}`}
                      style={{ height: `${Math.min(100, (audioLvl / 100) * 100)}%` }}
                    ></div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Recent events */}
        <div className="dashboard-panel events-panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Recent events</h3>
              <p className="panel-subtitle">Alerts and SMS from the Pi</p>
            </div>
          </div>
          {(() => {
            const items = [
              ...audioDetections
                .filter((d) => d.status === 'ATTENTION NEEDED')
                .map((d) => ({
                  t: d.created_at,
                  tone: 'warn',
                  text: `${d.cough_events} cough, ${d.stress_events} stress sounds (${d.top_class ?? 'audio'})`,
                })),
              ...smsLogs.map((l) => ({
                t: l.created_at,
                tone: l.status === 'failed' ? 'alert' : 'info',
                text: `SMS ${l.status === 'failed' ? 'failed' : 'sent'}: ${SMS_TYPE_LABEL[l.alert_type ?? ''] ?? l.alert_type}`,
              })),
            ]
              .sort((x, y) => new Date(y.t).getTime() - new Date(x.t).getTime())
              .slice(0, 8);
            if (!items.length) return <p className="events-empty">Nothing to report. Alerts and SMS will show up here.</p>;
            return (
              <ul className="events-list">
                {items.map((it, i) => (
                  <li key={i} className={`event-row tone-${it.tone}`}>
                    <span className="event-time">
                      {new Date(it.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span className="event-text">{it.text}</span>
                  </li>
                ))}
              </ul>
            );
          })()}
        </div>
          </>
        )}

        {/* Camera + Audio */}
        {section === 'camera' && (
        <div className="dashboard-panel">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 className="panel-title">Pen camera</h3>
              <p className="panel-subtitle">
                {feedMode === 'webcam' ? 'Webcam on this computer' : feedMode === 'video' ? 'Uploaded video' : 'Latest frame from the Pi'}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="feed-source-toggle">
                <button
                  type="button"
                  className={`source-btn ${feedMode === 'stream' ? 'active' : ''}`}
                  onClick={() => setFeedMode('stream')}
                  title="Pen Camera / Stream"
                >
                  <Camera style={{ width: 12, height: 12, marginRight: 4 }} /> Pen
                </button>
                <button
                  type="button"
                  className={`source-btn ${feedMode === 'webcam' ? 'active' : ''}`}
                  onClick={() => setFeedMode('webcam')}
                  title="Live Webcam"
                >
                  <Video style={{ width: 12, height: 12, marginRight: 4 }} /> Webcam
                </button>
                <button
                  type="button"
                  className={`source-btn ${feedMode === 'video' ? 'active' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload Video File"
                >
                  <Upload style={{ width: 12, height: 12, marginRight: 4 }} /> Video
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/ogg"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const url = URL.createObjectURL(file);
                      setUploadedVideoUrl(url);
                      setFeedMode('video');
                    }
                  }}
                />
              </div>
              <span className="live-rec-badge">
                <span className="rec-dot"></span> LIVE
              </span>
            </div>
          </div>

          <div className="camera-frame">
            {feedMode === 'webcam' || (feedMode === 'video' && uploadedVideoUrl) ? (
              <video
                ref={cameraVideoRef}
                src={feedMode === 'video' ? uploadedVideoUrl || undefined : undefined}
                autoPlay
                playsInline
                muted
                loop
                className="snapshot-image"
              />
            ) : (
              <img
                ref={cameraImageRef}
                src={cameraFeedUrl}
                onError={(e) => {
                  // only fall back to a real snapshot from the Pi, never a stock photo
                  if (latestLog.image_url && cameraFeedUrl !== latestLog.image_url) {
                    setCameraFeedUrl(latestLog.image_url);
                  } else {
                    e.currentTarget.dataset.broken = 'true';
                  }
                }}
                onLoad={(e) => {
                  e.currentTarget.dataset.broken = 'false';
                }}
                alt=""
                className="snapshot-image"
                crossOrigin="anonymous"
              />
            )}
            {pigDetections.map((detection) => (
              <div
                key={`pig-track-${detection.id}`}
                className={`pig-detection-box ${detection.isMoving ? 'moving' : 'resting'} ${detection.label === 'Piglet' ? 'piglet' : ''}`}
                style={{
                  left: `${detection.bbox[0] * 100}%`,
                  top: `${detection.bbox[1] * 100}%`,
                  width: `${detection.bbox[2] * 100}%`,
                  height: `${detection.bbox[3] * 100}%`,
                }}
              >
                <div className="pig-detection-tag">
                  <span className={`motion-tag-dot ${detection.isMoving ? 'pulse-moving' : 'still'}`}></span>
                  <span className="pig-id-text">#{detection.id}</span>
                  <span className="pig-motion-label">{detection.isMoving ? 'Moving' : 'Resting'}</span>
                  <span className="pig-conf">{(detection.score * 100).toFixed(0)}%</span>
                </div>
              </div>
            ))}
            <div className="frame-overlay">
              <div className="overlay-top">
                <span className="cam-id">CAM-01 • AI VISION</span>
                <span className="overlay-time">{new Date(latestLog.created_at).toLocaleTimeString()}</span>
              </div>
              <div className="ai-count-overlay">
                {aiStatus === 'ready' ? (
                  pigDetections.length === 0 ? (
                    '0 pigs in pen'
                  ) : (
                    <div className="ai-stats-pill-row">
                      <span className="ai-stat-chip total">
                        {pigDetections.length} Total
                      </span>
                      <span className="ai-stat-chip moving">
                        🟢 {movingPigs.length} Moving
                      </span>
                      <span className="ai-stat-chip resting">
                        💤 {restingPigs.length} Resting
                      </span>
                    </div>
                  )
                ) : aiStatus === 'loading' ? (
                  'AI tracking pen activity...'
                ) : (
                  'AI offline'
                )}
              </div>
            </div>
          </div>

          {/* Quick stats under camera */}
          <div className="camera-stats">
            <div className="camera-stat">
              <Thermometer style={{ width: 14, height: 14, color: '#2f5d50' }} />
              <span>{formatTemp(ambientTempNum)}°C</span>
            </div>
            <div className="camera-stat">
              <Volume2 style={{ width: 14, height: 14, color: '#6366f1' }} />
              <span>{fmtDb(latestAudio)} dB</span>
            </div>
            <div className="camera-stat">
              <Activity style={{ width: 14, height: 14, color: movingPigs.length > 0 ? '#059669' : '#94a3b8' }} />
              <span>{movingPigs.length > 0 ? `${movingPigs.length} Moving` : 'Resting'}</span>
            </div>
          </div>

          {/* Real-Time Pig Activity Indicator (Moving vs Resting) */}
          <div className="pig-motion-indicator-card">
            <div className="indicator-status-row">
              <div className="indicator-badge-group">
                <span className={`live-activity-pill ${movingPigs.length > 0 ? 'moving' : 'resting'}`}>
                  <span className={`beacon-dot ${movingPigs.length > 0 ? 'pulse-green' : 'still-blue'}`}></span>
                  {pigDetections.length === 0 ? 'No pigs detected' : movingPigs.length > 0 ? 'Pigs moving' : 'Pigs resting'}
                </span>
              </div>
              <div className="indicator-counts-group">
                <span className="activity-count-badge moving">
                  🟢 {movingPigs.length} Moving
                </span>
                <span className="activity-count-badge resting">
                  💤 {restingPigs.length} Resting
                </span>
              </div>
            </div>

            <div className="mobility-progress-row">
              <div className="mobility-label-row">
                <span className="mobility-label">Moving now</span>
                <span className="mobility-percentage">{herdActivityRate}% Active</span>
              </div>
              <div className="mobility-track">
                <div 
                  className="mobility-fill"
                  style={{ width: `${herdActivityRate}%` }}
                ></div>
              </div>
            </div>
          </div>

          {/* Audio player */}
          <div className="audio-player-card">
            <div className="audio-info">
              <Volume2 style={{ width: 18, height: 18, color: '#6366f1' }} />
              <div>
                <h4 className="audio-title">Latest sound clip</h4>
                <p className="audio-subtitle">
                  {latestLog.audio_url ? 'Sound snippet available' : 'No audio attached'}
                </p>
              </div>
            </div>

            {latestLog.audio_url ? (
              <>
                <audio
                  id="latest-pig-audio"
                  src={latestLog.audio_url}
                  onEnded={() => setIsPlayingAudio(false)}
                  onError={() => setAudioError(true)}
                />
                <button
                  className={`audio-play-btn ${isPlayingAudio ? 'playing' : ''}`}
                  onClick={toggleAudioPlayback}
                >
                  {isPlayingAudio ? (
                    <><Pause style={{ width: 14, height: 14, marginRight: 6 }} /> Pause</>
                  ) : (
                    <><Play style={{ width: 14, height: 14, marginRight: 6 }} /> Play</>
                  )}
                </button>
              </>
            ) : (
              <div className="no-audio-text">
                <VolumeX style={{ width: 14, height: 14, marginRight: 4 }} /> No Audio
              </div>
            )}
            {audioError && <p style={{ fontSize: '0.7rem', color: '#e11d48', margin: '4px 0 0' }}>Unable to load audio</p>}
          </div>

          {/* Nav footer */}
          <button className="view-all-logs-btn" onClick={onNavigateLogs}>
            View all logs ({logs.length})
            <ArrowRight style={{ width: 14, height: 14 }} />
          </button>
        </div>
        )}
      </div>
      )}
    </div>
  );
};
