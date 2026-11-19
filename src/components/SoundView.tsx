import React, { useEffect, useMemo, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import type { AudioDetection, SystemSetting } from '../types';
import { AudioTesterView } from './AudioTesterView';

interface SoundViewProps {
  audioDetections: AudioDetection[];
  settings: SystemSetting[];
}

/** Sound page: what the Pi's microphone AI heard + the cough tester. */
export const SoundView: React.FC<SoundViewProps> = ({ audioDetections, settings }) => {
  const [playing, setPlaying] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);
  const rows = audioDetections.slice(0, 30);

  const summary = useMemo(() => {
    const day = audioDetections.filter((d) => clock - new Date(d.created_at).getTime() < 24 * 3600 * 1000);
    return {
      windows: day.length,
      coughs: day.reduce((a, d) => a + d.cough_events, 0),
      stress: day.reduce((a, d) => a + d.stress_events, 0),
      attention: day.filter((d) => d.status === 'ATTENTION NEEDED').length,
    };
  }, [audioDetections, clock]);

  const toggle = (d: AudioDetection) => {
    const el = document.getElementById(`det-audio-${d.id}`) as HTMLAudioElement | null;
    if (!el) return;
    document.querySelectorAll<HTMLAudioElement>('audio[data-det]').forEach((a) => a !== el && a.pause());
    if (playing === d.id) {
      el.pause();
      setPlaying(null);
    } else {
      void el.play();
      setPlaying(d.id);
    }
  };

  return (
    <div className="page-stack">
      <div className="kpi-grid compact">
        <div className="kpi-card">
          <div className="kpi-header"><span className="kpi-label">Coughs, last 24 h</span></div>
          <div className="kpi-value-row"><span className="kpi-value">{summary.coughs}</span></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-header"><span className="kpi-label">Stress sounds, last 24 h</span></div>
          <div className="kpi-value-row"><span className="kpi-value">{summary.stress}</span></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-header"><span className="kpi-label">Needed attention</span></div>
          <div className="kpi-value-row">
            <span className="kpi-value">{summary.attention}</span>
            <span className="kpi-unit">of {summary.windows} checks</span>
          </div>
        </div>
      </div>

      <section className="dashboard-panel">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">What the Pi heard</h3>
            <p className="panel-subtitle">One row per audio summary from the barn microphone, newest first.</p>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="events-empty">No audio summaries yet. The Pi saves one every audio interval.</p>
        ) : (
          <div className="table-responsive">
            <table className="logs-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Result</th>
                  <th>Loudest sound</th>
                  <th className="num">Coughs</th>
                  <th className="num">Stress</th>
                  <th className="num">Highest cough score</th>
                  <th>Clip</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="log-time">
                      {new Date(d.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </td>
                    <td>
                      <span className={`status-chip ${d.status === 'ATTENTION NEEDED' ? 'alert' : 'ok'}`}>
                        {d.status === 'ATTENTION NEEDED' ? 'Attention' : 'Healthy'}
                      </span>
                    </td>
                    <td>{d.top_class ?? '—'}</td>
                    <td className="num">{d.cough_events}</td>
                    <td className="num">{d.stress_events}</td>
                    <td className="num">{d.cough_prob != null ? `${Math.round(d.cough_prob * 100)}%` : '—'}</td>
                    <td>
                      {d.audio_url ? (
                        <>
                          <audio id={`det-audio-${d.id}`} data-det src={d.audio_url} preload="none" onEnded={() => setPlaying(null)} />
                          <button className="icon-btn" onClick={() => toggle(d)} aria-label={playing === d.id ? 'Pause clip' : 'Play clip'}>
                            {playing === d.id ? <Pause className="btn-icon" /> : <Play className="btn-icon" />}
                          </button>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="panel-note">
          The Pi re-uses one clip file, so older rows may play the newest recording.
        </p>
      </section>

      <AudioTesterView settings={settings} />
    </div>
  );
};
