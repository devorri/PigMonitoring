import React, { useState } from 'react';
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
} from 'lucide-react';

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
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Live Camera Feed</h3>
              <p className="panel-subtitle">Latest pen snapshot</p>
            </div>
            <span className="live-rec-badge">
              <span className="rec-dot"></span> LIVE
            </span>
          </div>

          <div className="camera-frame">
            <img
              src={latestLog.image_url || 'https://images.unsplash.com/photo-1516467508483-a7212febe31a?auto=format&fit=crop&w=1000&q=80'}
              alt="Pig Pen Live Snapshot"
              className="snapshot-image"
            />
            <div className="frame-overlay">
              <div className="overlay-top">
                <span className="cam-id">CAM-01</span>
                <span className="overlay-time">{new Date(latestLog.created_at).toLocaleTimeString()}</span>
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
