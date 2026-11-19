import React, { useEffect, useState } from 'react';
import type { SystemSetting } from '../types';
import {
  RotateCcw,
  Sliders,
  Thermometer,
  Volume2,
  Camera,
  Bell,
  Check,
  X,
  Info,
  Cpu,
  Timer,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';
import {
  PI_OFFLINE_AFTER_S,
  SETTINGS_SPEC,
  SPEC_BY_KEY,
  parseRelayState,
  settingValue,
  validateSetting,
  type SettingSpec,
} from '../lib/settingsSpec';

interface SystemSettingsViewProps {
  settings: SystemSetting[];
  onUpdateSetting: (key: string, value: string) => void;
  onResetDefaults?: () => void;
}

const GROUP_ICON: Record<SettingSpec['group'], React.ReactNode> = {
  Relays: <Thermometer className="w-5 h-5 text-rose-400" />,
  Camera: <Camera className="w-5 h-5 text-emerald-400" />,
  'Audio AI': <Volume2 className="w-5 h-5 text-indigo-400" />,
  Timing: <Timer className="w-5 h-5 text-blue-400" />,
  'SMS alerts': <MessageSquare className="w-5 h-5 text-pink-600" />,
  'Website alerts': <Bell className="w-5 h-5 text-amber-400" />,
  'Pi status': <Cpu className="w-5 h-5 text-slate-400" />,
};

const GROUPS: SettingSpec['group'][] = ['Relays', 'SMS alerts', 'Audio AI', 'Camera', 'Timing', 'Website alerts', 'Pi status'];

export const SystemSettingsView: React.FC<SystemSettingsViewProps> = ({
  settings,
  onUpdateSetting,
  onResetDefaults,
}) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  const [editError, setEditError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = window.setInterval(() => setNowSec(Date.now() / 1000), 5000);
    return () => window.clearInterval(id);
  }, []);

  const rowOf = (key: string) => settings.find((s) => s.setting_key === key);
  const unknownRows = settings.filter((s) => !SPEC_BY_KEY[s.setting_key]);

  const startEdit = (spec: SettingSpec) => {
    setEditingKey(spec.key);
    setEditingValue(settingValue(settings, spec.key));
    setEditError(null);
  };

  const save = (key: string) => {
    const r = validateSetting(key, editingValue);
    if (!r.ok) {
      setEditError(r.error);
      return;
    }
    onUpdateSetting(key, r.value);
    setEditingKey(null);
    setEditError(null);
  };

  const renderInput = (spec: SettingSpec) => {
    if (spec.kind === 'enum' || spec.kind === 'bool') {
      const opts = spec.kind === 'bool' ? ['true', 'false'] : spec.options!;
      return (
        <select className="setting-input" value={editingValue} onChange={(e) => setEditingValue(e.target.value)} autoFocus>
          {opts.map((o) => (
            <option key={o} value={o}>
              {spec.kind === 'bool' ? (o === 'true' ? 'On' : 'Off') : o}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        type="number"
        className="setting-input"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={editingValue}
        onChange={(e) => setEditingValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save(spec.key)}
        autoFocus
      />
    );
  };

  const renderStatus = (spec: SettingSpec) => {
    const raw = rowOf(spec.key)?.setting_value ?? '';
    if (spec.key === 'relay_state') {
      const r = parseRelayState(settings);
      if (!r) return <span className="status-text">Pi has not reported yet</span>;
      const age = Math.max(0, Math.round(nowSec - r.t));
      return (
        <span className="status-text">
          Bulb {r.bulb ? 'ON' : 'OFF'} · Water {r.solenoid ? 'ON' : 'OFF'} · Heat protection {r.phase}
          {r.phase !== 'idle' && ` (cycle ${r.cycle}, ${r.left}s left)`} · peak {r.temp ?? '--'}°C
          <br />
          <small style={{ opacity: 0.7 }}>
            {age < PI_OFFLINE_AFTER_S ? `● Pi online, updated ${age}s ago` : `○ Pi offline, last update ${Math.round(age / 60)} min ago`}
          </small>
        </span>
      );
    }
    return (
      <span className="status-text">
        {raw || 'Pi has not reported yet'}
      </span>
    );
  };

  return (
    <div className="system-settings-view">
      {/* Header */}
      <div className="view-header">
        <div>
          <h1 className="view-title">Settings</h1>
          <p className="view-subtitle">
            The same settings the Raspberry Pi reads every 10 seconds. Values are checked with the same limits the Pi uses.
          </p>
        </div>
        <div className="view-header-actions">
          {onResetDefaults && (
            <button className="secondary-btn" onClick={onResetDefaults}>
              <RotateCcw className="btn-icon" /> Reset demo data
            </button>
          )}
        </div>
      </div>

      {GROUPS.map((group) => (
        <div key={group}>
          <h3 className="settings-group-title">
            {GROUP_ICON[group]} {group}
          </h3>
          <div className="settings-grid">
            {SETTINGS_SPEC.filter((s) => s.group === group).map((spec) => {
              const row = rowOf(spec.key);
              const isEditing = editingKey === spec.key;
              const inDb = row !== undefined;
              const dbInvalid = inDb && spec.kind !== 'status' && !validateSetting(spec.key, row!.setting_value ?? '').ok;
              const current = settingValue(settings, spec.key);

              return (
                <div key={spec.key} className="setting-card">
                  <div className="setting-card-header">
                    <div className="setting-icon-box">{GROUP_ICON[group]}</div>
                    <div className="setting-title-box">
                      <h4 className="setting-key">{spec.label}</h4>
                      <span className="setting-raw-key">
                        {spec.key} · {spec.owner === 'pi' ? (spec.kind === 'status' ? 'written by Pi' : 'used by Pi') : 'website only'}
                      </span>
                    </div>
                  </div>

                  <div className="setting-card-body">
                    {spec.kind === 'status' ? (
                      renderStatus(spec)
                    ) : isEditing ? (
                      <div className="setting-edit-box">
                        {renderInput(spec)}
                        <div className="setting-edit-actions">
                          <button className="save-mini-btn" onClick={() => save(spec.key)}>
                            <Check className="w-4 h-4 mr-1 inline" /> Save
                          </button>
                          <button className="cancel-mini-btn" onClick={() => setEditingKey(null)}>
                            <X className="w-4 h-4 inline" />
                          </button>
                        </div>
                        {editError && (
                          <span style={{ color: '#dc2626', fontSize: '0.75rem' }}>{editError}</span>
                        )}
                      </div>
                    ) : (
                      <div className="setting-value-display">
                        <span className="setting-value">
                          {spec.kind === 'bool' ? (current === 'true' ? 'On' : 'Off') : current}
                          {spec.unit ? ` ${spec.unit}` : ''}
                        </span>
                        <button className="edit-setting-btn" onClick={() => startEdit(spec)}>
                          Edit
                        </button>
                      </div>
                    )}
                    <p className="text-xs text-slate-400" style={{ margin: 0 }}>
                      {spec.description}
                      {spec.kind === 'number' && ` Range ${spec.min} to ${spec.max}${spec.unit ? ' ' + spec.unit : ''}.`}
                      {spec.kind === 'status' ? '' : ` Default ${spec.default}${spec.unit ? ' ' + spec.unit : ''}.`}
                    </p>
                  </div>

                  <div className="setting-card-footer">
                    <span className="setting-updated">
                      {!inDb ? (
                        spec.kind === 'status' ? (
                          'Not in database yet'
                        ) : (
                          'Not in database yet, the Pi uses the default'
                        )
                      ) : dbInvalid ? (
                        <span style={{ color: '#b45309' }}>
                          <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                          Saved value "{row!.setting_value}" is invalid, the Pi uses the default
                        </span>
                      ) : (
                        `Updated: ${new Date(row!.updated_at).toLocaleString()}`
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {unknownRows.length > 0 && (
        <div>
          <h3 className="settings-group-title">
            <Sliders className="w-5 h-5 text-slate-400" /> Not used anymore
          </h3>
          <div className="settings-grid">
            {unknownRows.map((row) => (
              <div key={row.id} className="setting-card" style={{ opacity: 0.6 }}>
                <div className="setting-card-header">
                  <div className="setting-icon-box">
                    <Sliders className="w-5 h-5 text-slate-400" />
                  </div>
                  <div className="setting-title-box">
                    <h4 className="setting-key">{row.setting_key}</h4>
                    <span className="setting-raw-key">nothing reads this key</span>
                  </div>
                </div>
                <div className="setting-card-body">
                  <span className="setting-value">{row.setting_value}</span>
                </div>
                <div className="setting-card-footer">
                  <span className="setting-updated">Safe to delete (see supabase_pi_setup.sql step 2b)</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="info-box-card">
        <Info className="w-5 h-5 text-indigo-400 mr-3 flex-shrink-0" />
        <div>
          <h4 className="text-sm font-semibold text-slate-200">One set of settings everywhere</h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Keys, defaults and limits are identical in the website (<code>src/lib/settingsSpec.ts</code>), the Pi (
            <code>SETTINGS_SPEC</code> in <code>pi/app.py</code>) and the database (<code>supabase_pi_setup.sql</code>).
            A missing or invalid value means the default, on the Pi and here.
          </p>
        </div>
      </div>
    </div>
  );
};
