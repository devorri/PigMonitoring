import React, { useEffect, useRef, useState } from 'react';
import * as ort from 'onnxruntime-web';
import type { SensorLog, SystemSetting } from '../types';
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
} from 'lucide-react';

const LIVE_CAMERA_FEED_URL = '/camera-stream';
const PIG_MODEL_URL = '/models/best.onnx';

interface DashboardOverviewProps {
  logs: SensorLog[];
  settings: SystemSetting[];
  onNavigateLogs: () => void;
  onNavigateSettings: () => void;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  logs,
  settings,
  onNavigateLogs,
  onNavigateSettings,
}) => {
  const latestLog = logs[0] || {
    id: 0,
    created_at: new Date().toISOString(),
    ambient_temp: 22.4,
    floor_temp: 20.8,
    motion_detected: true,
    audio_level: 52,
    image_url: 'https://images.unsplash.com/photo-1516467508483-a7212febe31a?auto=format&fit=crop&w=1000&q=80',
    audio_url: 'https://actions.google.com/sounds/v1/animals/pig_grunt.ogg',
  };

  const cleanAudioLevel = (val: number): number => {
    if (isNaN(val) || val <= 0) return 45;
    if (val > 140) return (val % 40) + 50;
    return Math.round(val);
  };

  const latestAudio = cleanAudioLevel(latestLog.audio_level);

  const getSettingValue = (key: string, defaultVal: number): number => {
    const found = settings.find((s) => s.setting_key === key);
    return found ? parseFloat(found.setting_value) || defaultVal : defaultVal;
  };

  const highTempThreshold = getSettingValue('temp_threshold_high', 26.5);
  const lowTempThreshold = getSettingValue('temp_threshold_low', 18.0);
  const noiseThreshold = getSettingValue('noise_alert_level', 75);

  const isHighTemp = latestLog.ambient_temp > highTempThreshold;
  const isLowTemp = latestLog.ambient_temp < lowTempThreshold;
  const isHighNoise = latestAudio > noiseThreshold;
  const isOptimal = !isHighTemp && !isLowTemp && !isHighNoise;

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
  const maxTemp = Math.max(...chartLogs.map((l) => Math.max(l.ambient_temp, l.floor_temp, 30)), 32);
  const minTemp = Math.min(...chartLogs.map((l) => Math.min(l.ambient_temp, l.floor_temp, 15)), 12);
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

  const ambientPts = chartLogs.map((l, i) => ({ x: getX(i), y: getY(l.ambient_temp) }));
  const floorPts = chartLogs.map((l, i) => ({ x: getX(i), y: getY(l.floor_temp) }));

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
  const [pigDetections, setPigDetections] = useState<{ bbox: [number, number, number, number]; score: number; label: string }[]>([]);
  const [aiStatus, setAiStatus] = useState<'loading' | 'ready' | 'blocked'>('loading');

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

  useEffect(() => {
    let cancelled = false;
    let detecting = false;
    let session: ort.InferenceSession | null = null;

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
      } else {
        const img = cameraImageRef.current;
        if (img && img.complete && img.naturalWidth > 0) {
          mediaSource = img;
        }
      }

      if (!mediaSource || detecting) return;

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

        if (cancelled) return;
        setPigDetections(selected);
        setAiStatus('ready');
      } catch {
        if (!cancelled) setAiStatus('blocked');
      } finally {
        detecting = false;
      }
    };

    detectPigs();
    const intervalMs = feedMode === 'stream' ? 1500 : 250;
    const timer = window.setInterval(detectPigs, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [feedMode, uploadedVideoUrl]);

  // Prev log comparison
  const prevLog = logs[1];
  const tempDiff = prevLog ? +(latestLog.ambient_temp - prevLog.ambient_temp).toFixed(1) : 0;
  const audioDiff = prevLog ? latestLog.audio_level - prevLog.audio_level : 0;

  return (
    <div className="dashboard-overview">
      {/* Status bar */}
      {!isOptimal && (
        <div className="status-alert-bar">
          <div className="status-alert-dot"></div>
          <span className="status-alert-text">
            {isHighTemp
              ? `High temperature detected: ${latestLog.ambient_temp.toFixed(1)}°C (threshold: ${highTempThreshold}°C)`
              : isLowTemp
              ? `Low temperature detected: ${latestLog.ambient_temp.toFixed(1)}°C (threshold: ${lowTempThreshold}°C)`
              : `High noise level detected: ${latestAudio} dB (threshold: ${noiseThreshold} dB)`}
          </span>
          <button className="status-alert-action" onClick={onNavigateSettings}>
            Adjust Thresholds
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon-circle pink">
              <Thermometer style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Ambient Temp</span>
          </div>
          <div className="kpi-value-row">
            <span className="kpi-value">{latestLog.ambient_temp.toFixed(1)}</span>
            <span className="kpi-unit">°C</span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${isHighTemp ? 'red' : isLowTemp ? 'amber' : 'green'}`}>
              {isHighTemp ? 'Above threshold' : isLowTemp ? 'Below threshold' : 'Normal'}
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
            <span className="kpi-label">Floor Temp</span>
          </div>
          <div className="kpi-value-row">
            <span className="kpi-value">{latestLog.floor_temp.toFixed(1)}</span>
            <span className="kpi-unit">°C</span>
          </div>
          <div className="kpi-footer">
            <span className="kpi-badge neutral">
              {(latestLog.ambient_temp - latestLog.floor_temp).toFixed(1)}° difference
            </span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-header">
            <div className="kpi-icon-circle indigo">
              <Volume2 style={{ width: 18, height: 18 }} />
            </div>
            <span className="kpi-label">Noise Level</span>
          </div>
          <div className="kpi-value-row">
            <span className="kpi-value">{latestAudio}</span>
            <span className="kpi-unit">dB</span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${isHighNoise ? 'red' : 'green'}`}>
              {isHighNoise ? 'High noise' : 'Quiet'}
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
              {latestLog.motion_detected ? 'Active' : 'Resting'}
            </span>
          </div>
          <div className="kpi-footer">
            <span className={`kpi-badge ${latestLog.motion_detected ? 'green' : 'neutral'}`}>
              {latestLog.motion_detected ? 'Movement detected' : 'No movement'}
            </span>
          </div>
        </div>
      </div>

      {/* Main Grid: Chart + Camera */}
      <div className="dashboard-grid-main">
        {/* Temperature Chart */}
        <div className="dashboard-panel">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Temperature Trend</h3>
              <p className="panel-subtitle">Last {chartLogs.length} readings</p>
            </div>
            <div className="chart-legend">
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#db2777' }}></span> Ambient
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: '#f59e0b' }}></span> Floor
              </span>
            </div>
          </div>

          <div className="chart-container" onMouseLeave={() => setActiveChartPoint(null)}>
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
                x1={padding} y1={getY(highTempThreshold)}
                x2={svgWidth - padding} y2={getY(highTempThreshold)}
                stroke="#fda4af" strokeDasharray="6 4" strokeWidth="1"
              />
              <text x={svgWidth - padding} y={getY(highTempThreshold) - 6} fill="#fb7185" fontSize="9" textAnchor="end" fontWeight="600">
                {highTempThreshold}° limit
              </text>

              {/* Area fills */}
              <path d={buildAreaPath(ambientPts)} fill="url(#ambientGradient)" />
              <path d={buildAreaPath(floorPts)} fill="url(#floorGradient)" />

              {/* Gradients */}
              <defs>
                <linearGradient id="ambientGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#db2777" stopOpacity="0.12" />
                  <stop offset="100%" stopColor="#db2777" stopOpacity="0.01" />
                </linearGradient>
                <linearGradient id="floorGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.08" />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.01" />
                </linearGradient>
              </defs>

              {/* Lines */}
              <path d={buildPath(floorPts)} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d={buildPath(ambientPts)} fill="none" stroke="#db2777" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

              {/* Data points */}
              {chartLogs.map((log, index) => {
                const cx = getX(index);
                const cyAmbient = getY(log.ambient_temp);
                const cyFloor = getY(log.floor_temp);
                const isSelected = activeChartPoint?.id === log.id;

                return (
                  <g key={log.id} className="chart-point-group" onMouseEnter={() => setActiveChartPoint(log)}>
                    <circle cx={cx} cy={cyAmbient} r={isSelected ? 5 : 3} fill="#db2777" stroke="#fff" strokeWidth="2" />
                    <circle cx={cx} cy={cyFloor} r={isSelected ? 4 : 2.5} fill="#f59e0b" stroke="#fff" strokeWidth="2" />
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
                  <span style={{ color: '#db2777', fontWeight: 600 }}>{activeChartPoint.ambient_temp.toFixed(1)}°C</span>
                  <span style={{ color: '#f59e0b', fontWeight: 600 }}>{activeChartPoint.floor_temp.toFixed(1)}°C</span>
                  <span style={{ color: '#64748b' }}>{cleanAudioLevel(activeChartPoint.audio_level)} dB</span>
                </div>
              </div>
            )}
          </div>

          {/* Audio bars */}
          <div className="audio-timeline-section">
            <div className="audio-timeline-header">
              <span className="audio-timeline-label">Audio Timeline</span>
              <span className="audio-timeline-avg">
                Avg: {Math.round(chartLogs.reduce((acc, l) => acc + cleanAudioLevel(l.audio_level), 0) / (chartLogs.length || 1))} dB
              </span>
            </div>
            <div className="audio-bars-grid">
              {chartLogs.map((log) => {
                const audioLvl = cleanAudioLevel(log.audio_level);
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

        {/* Camera + Audio */}
        <div className="dashboard-panel">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 className="panel-title">Live Camera Feed</h3>
              <p className="panel-subtitle">
                {feedMode === 'webcam' ? 'PC Live Webcam Feed' : feedMode === 'video' ? 'Uploaded Video Clip' : 'Latest pen snapshot / stream'}
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
                onError={() => {
                  const fallback = latestLog.image_url || 'https://images.unsplash.com/photo-1516467508483-a7212febe31a?auto=format&fit=crop&w=1000&q=80';
                  if (cameraFeedUrl !== fallback) {
                    setCameraFeedUrl(fallback);
                  }
                }}
                alt="Pig Pen Live Snapshot"
                className="snapshot-image"
                crossOrigin="anonymous"
              />
            )}
            {pigDetections.map((detection, index) => (
              <div
                key={`${index}-${detection.bbox.join('-')}`}
                className={`pig-detection-box ${detection.label === 'Piglet' ? 'piglet' : ''}`}
                style={{
                  left: `${detection.bbox[0] * 100}%`,
                  top: `${detection.bbox[1] * 100}%`,
                  width: `${detection.bbox[2] * 100}%`,
                  height: `${detection.bbox[3] * 100}%`,
                }}
              >
                {detection.label} {(detection.score * 100).toFixed(0)}%
              </div>
            ))}
            <div className="frame-overlay">
              <div className="overlay-top">
                <span className="cam-id">CAM-01</span>
                <span className="overlay-time">{new Date(latestLog.created_at).toLocaleTimeString()}</span>
              </div>
              <div className="ai-count-overlay">
                {aiStatus === 'ready'
                  ? pigDetections.length === 0
                    ? '0 pigs detected'
                    : pigDetections.filter((d) => d.label === 'Piglet').length > 0
                    ? `${pigDetections.filter((d) => d.label === 'Pig').length} pig${pigDetections.filter((d) => d.label === 'Pig').length === 1 ? '' : 's'}, ${pigDetections.filter((d) => d.label === 'Piglet').length} piglet${pigDetections.filter((d) => d.label === 'Piglet').length === 1 ? '' : 's'}`
                    : `${pigDetections.length} pig${pigDetections.length === 1 ? '' : 's'} detected`
                  : aiStatus === 'loading'
                  ? 'AI analyzing...'
                  : 'AI offline'}
              </div>
            </div>
          </div>

          {/* Quick stats under camera */}
          <div className="camera-stats">
            <div className="camera-stat">
              <Thermometer style={{ width: 14, height: 14, color: '#db2777' }} />
              <span>{latestLog.ambient_temp.toFixed(1)}°C</span>
            </div>
            <div className="camera-stat">
              <Volume2 style={{ width: 14, height: 14, color: '#6366f1' }} />
              <span>{latestAudio} dB</span>
            </div>
            <div className="camera-stat">
              <Activity style={{ width: 14, height: 14, color: latestLog.motion_detected ? '#059669' : '#94a3b8' }} />
              <span>{latestLog.motion_detected ? 'Motion' : 'Still'}</span>
            </div>
          </div>

          {/* Audio player */}
          <div className="audio-player-card">
            <div className="audio-info">
              <Volume2 style={{ width: 18, height: 18, color: '#6366f1' }} />
              <div>
                <h4 className="audio-title">Audio Clip</h4>
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
            View All Logs ({logs.length})
            <ArrowRight style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>
    </div>
  );
};
