import React, { useState } from 'react';
import type { NewSensorLog, SensorLog } from '../types';
import { 
  Search, 
  Filter, 
  Plus, 
  Thermometer, 
  Volume2, 
  Activity, 
  Image as ImageIcon, 
  Play, 
  Pause, 
  X,
  FileText,
  Clock,
  Sparkles,
  Download
} from 'lucide-react';

interface SensorLogsViewProps {
  logs: SensorLog[];
  onAddLog: (newLog: NewSensorLog) => void;
}

export const SensorLogsView: React.FC<SensorLogsViewProps> = ({ logs, onAddLog }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [motionFilter, setMotionFilter] = useState<'all' | 'motion' | 'still'>('all');
  const [minAudio, setMinAudio] = useState<number>(0);
  const [selectedLog, setSelectedLog] = useState<SensorLog | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Form State for Add Log Modal
  const [formData, setFormData] = useState<NewSensorLog>({
    ambient_temp: 22.5,
    floor_temp: 21.0,
    motion_detected: true,
    audio_level: 55,
    image_url: 'https://images.unsplash.com/photo-1516467508483-a7212febe31a?auto=format&fit=crop&w=1000&q=80',
    audio_url: 'https://actions.google.com/sounds/v1/animals/pig_grunt.ogg',
  });

  // Audio Playback in Modal
  const [modalAudioPlaying, setModalAudioPlaying] = useState(false);

  const toggleModalAudio = () => {
    if (!selectedLog?.audio_url) return;
    const el = document.getElementById('modal-audio-element') as HTMLAudioElement;
    if (el) {
      if (modalAudioPlaying) {
        el.pause();
        setModalAudioPlaying(false);
      } else {
        el.play().then(() => setModalAudioPlaying(true)).catch(() => {});
      }
    }
  };

  // Filter Logic
  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.id.toString().includes(searchTerm) ||
      new Date(log.created_at).toLocaleString().toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesMotion =
      motionFilter === 'all'
        ? true
        : motionFilter === 'motion'
        ? log.motion_detected
        : !log.motion_detected;

    const matchesAudio = log.audio_level >= minAudio;

    return matchesSearch && matchesMotion && matchesAudio;
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAddLog(formData);
    setIsAddModalOpen(false);
    // Reset form to defaults
    setFormData({
      ambient_temp: 23.0,
      floor_temp: 21.5,
      motion_detected: true,
      audio_level: 60,
      image_url: 'https://images.unsplash.com/photo-1570042707221-39c4d9fa2435?auto=format&fit=crop&w=1000&q=80',
      audio_url: 'https://actions.google.com/sounds/v1/animals/pig_grunt.ogg',
    });
  };

  const exportCSV = () => {
    const headers = 'ID,Timestamp,Ambient Temp (°C),Floor Temp (°C),Motion Detected,Audio Level (dB),Image URL,Audio URL\n';
    const rows = filteredLogs
      .map(
        (l) =>
          `${l.id},"${new Date(l.created_at).toISOString()}",${l.ambient_temp},${l.floor_temp},${l.motion_detected},${l.audio_level},"${l.image_url || ''}","${l.audio_url || ''}"`
      )
      .join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pig_sensor_logs_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="sensor-logs-view">
      {/* Top Header & Controls */}
      <div className="view-header">
        <div>
          <h2 className="view-title">Sensor Logs & Telemetry History</h2>
          <p className="view-subtitle">Detailed record of temperature, noise decibels, motion, and snapshot feeds</p>
        </div>
        <div className="view-header-actions">
          <button className="secondary-btn" onClick={exportCSV}>
            <Download className="btn-icon" /> Export CSV
          </button>
          <button className="primary-btn" onClick={() => setIsAddModalOpen(true)}>
            <Plus className="btn-icon" /> Add Sensor Entry
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="filter-toolbar">
        <div className="search-input-wrapper">
          <Search className="search-icon" />
          <input
            type="text"
            placeholder="Search by Log ID or timestamp..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="filter-group">
          <div className="filter-item">
            <Filter className="filter-icon" />
            <select
              value={motionFilter}
              onChange={(e) => setMotionFilter(e.target.value as any)}
              className="filter-select"
            >
              <option value="all">All Motion States</option>
              <option value="motion">Motion Detected Only</option>
              <option value="still">Still / Idle Only</option>
            </select>
          </div>

          <div className="filter-item">
            <Volume2 className="filter-icon" />
            <select
              value={minAudio}
              onChange={(e) => setMinAudio(Number(e.target.value))}
              className="filter-select"
            >
              <option value={0}>All Noise Levels</option>
              <option value={50}>Min 50 dB</option>
              <option value={70}>Min 70 dB (High Noise)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="table-card">
        <div className="table-responsive">
          <table className="logs-table">
            <thead>
              <tr>
                <th>LOG ID</th>
                <th>TIMESTAMP</th>
                <th>AMBIENT TEMP</th>
                <th>FLOOR TEMP</th>
                <th>MOTION STATE</th>
                <th>AUDIO LEVEL</th>
                <th>ATTACHMENTS</th>
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-table-cell">
                    No sensor logs match your filter criteria.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="log-row" onClick={() => setSelectedLog(log)}>
                    <td className="log-id">#{log.id}</td>
                    <td className="log-time">
                      <div className="time-cell">
                        <Clock className="w-3.5 h-3.5 text-slate-400 mr-1.5 inline" />
                        {new Date(log.created_at).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </div>
                    </td>
                    <td>
                      <span className={`temp-badge ${log.ambient_temp > 26.5 ? 'warm' : 'normal'}`}>
                        <Thermometer className="w-3.5 h-3.5 mr-1 inline" />
                        {log.ambient_temp}°C
                      </span>
                    </td>
                    <td>
                      <span className="floor-badge">{log.floor_temp}°C</span>
                    </td>
                    <td>
                      <span className={`motion-badge ${log.motion_detected ? 'detected' : 'idle'}`}>
                        <Activity className="w-3.5 h-3.5 mr-1 inline" />
                        {log.motion_detected ? 'Detected' : 'No Motion'}
                      </span>
                    </td>
                    <td>
                      <div className="audio-cell">
                        <span className={`audio-pill ${log.audio_level > 75 ? 'alert' : ''}`}>
                          {log.audio_level} dB
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="attachment-icons">
                        {log.image_url && <span title="Image Available"><ImageIcon className="w-4 h-4 text-emerald-400" /></span>}
                        {log.audio_url && <span title="Audio Available"><Volume2 className="w-4 h-4 text-indigo-400 ml-1.5" /></span>}
                      </div>
                    </td>
                    <td>
                      <button className="view-detail-btn" onClick={(e) => { e.stopPropagation(); setSelectedLog(log); }}>
                        View Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span>Showing {filteredLogs.length} of {logs.length} total sensor log records</span>
        </div>
      </div>

      {/* Log Detail Modal */}
      {selectedLog && (
        <div className="modal-backdrop" onClick={() => setSelectedLog(null)}>
          <div className="modal-content log-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center space-x-2">
                <FileText className="w-5 h-5 text-indigo-400" />
                <h3 className="modal-title">Sensor Log Entry #{selectedLog.id}</h3>
              </div>
              <button className="close-btn" onClick={() => setSelectedLog(null)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="modal-body grid-2">
              {/* Snapshot Image Preview */}
              <div className="detail-media-column">
                <div className="detail-image-box">
                  {selectedLog.image_url ? (
                    <img src={selectedLog.image_url} alt="Log Snapshot" className="detail-img" />
                  ) : (
                    <div className="no-img-box">No Snapshot Image</div>
                  )}
                  <span className="detail-img-tag">Camera Capture Frame</span>
                </div>

                {selectedLog.audio_url && (
                  <div className="detail-audio-box">
                    <audio id="modal-audio-element" src={selectedLog.audio_url} onEnded={() => setModalAudioPlaying(false)} />
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-300">Audio Clip ({selectedLog.audio_level} dB)</span>
                      <button className="audio-play-btn" onClick={toggleModalAudio}>
                        {modalAudioPlaying ? <Pause className="w-4 h-4 mr-1 inline" /> : <Play className="w-4 h-4 mr-1 fill-current inline" />}
                        {modalAudioPlaying ? 'Pause Clip' : 'Play Audio'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Data Metrics Column */}
              <div className="detail-metrics-column">
                <div className="metric-row">
                  <span className="metric-label">Logged Timestamp</span>
                  <span className="metric-value">{new Date(selectedLog.created_at).toLocaleString()}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Ambient Temperature</span>
                  <span className="metric-value text-rose-400 font-bold">{selectedLog.ambient_temp}°C</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Floor Surface Temp</span>
                  <span className="metric-value text-amber-400 font-bold">{selectedLog.floor_temp}°C</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Noise Intensity</span>
                  <span className="metric-value text-indigo-400 font-bold">{selectedLog.audio_level} dB</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Motion Sensor State</span>
                  <span className={`metric-value font-bold ${selectedLog.motion_detected ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {selectedLog.motion_detected ? 'Motion Detected' : 'No Movement'}
                  </span>
                </div>

                <div className="raw-json-box">
                  <span className="raw-json-title">Raw Database Record:</span>
                  <pre className="raw-json-code">{JSON.stringify(selectedLog, null, 2)}</pre>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setSelectedLog(null)}>
                Close Window
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Sensor Log Modal */}
      {isAddModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsAddModalOpen(false)}>
          <div className="modal-content form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-emerald-400" />
                <h3 className="modal-title">Manual Telemetry Log Entry</h3>
              </div>
              <button className="close-btn" onClick={() => setIsAddModalOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddSubmit}>
              <div className="modal-body form-grid">
                <div className="form-group">
                  <label className="form-label">Ambient Temperature (°C)</label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    value={formData.ambient_temp}
                    onChange={(e) => setFormData({ ...formData, ambient_temp: parseFloat(e.target.value) || 0 })}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Floor Temperature (°C)</label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    value={formData.floor_temp}
                    onChange={(e) => setFormData({ ...formData, floor_temp: parseFloat(e.target.value) || 0 })}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Audio Level (dB)</label>
                  <input
                    type="number"
                    required
                    value={formData.audio_level}
                    onChange={(e) => setFormData({ ...formData, audio_level: parseInt(e.target.value) || 0 })}
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Motion State</label>
                  <select
                    value={formData.motion_detected ? 'true' : 'false'}
                    onChange={(e) => setFormData({ ...formData, motion_detected: e.target.value === 'true' })}
                    className="form-select"
                  >
                    <option value="true">Motion Detected (Active)</option>
                    <option value="false">No Motion (Resting)</option>
                  </select>
                </div>

                <div className="form-group full-width">
                  <label className="form-label">Snapshot Image URL</label>
                  <input
                    type="url"
                    value={formData.image_url || ''}
                    onChange={(e) => setFormData({ ...formData, image_url: e.target.value })}
                    className="form-input"
                    placeholder="https://images.unsplash.com/..."
                  />
                </div>

                <div className="form-group full-width">
                  <label className="form-label">Audio Clip URL</label>
                  <input
                    type="url"
                    value={formData.audio_url || ''}
                    onChange={(e) => setFormData({ ...formData, audio_url: e.target.value })}
                    className="form-input"
                    placeholder="https://actions.google.com/sounds/..."
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setIsAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn">
                  Submit Log Entry
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
