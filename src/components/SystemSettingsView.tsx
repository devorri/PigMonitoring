import React, { useState } from 'react';
import type { SystemSetting } from '../types';
import { 
  Plus, 
  RotateCcw, 
  Sliders, 
  Thermometer, 
  Volume2, 
  Activity, 
  Bell, 
  Check, 
  X,
  Sparkles,
  Info
} from 'lucide-react';

interface SystemSettingsViewProps {
  settings: SystemSetting[];
  onUpdateSetting: (key: string, value: string) => void;
  onResetDefaults?: () => void;
}

export const SystemSettingsView: React.FC<SystemSettingsViewProps> = ({
  settings,
  onUpdateSetting,
  onResetDefaults,
}) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // New Setting Form State
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const startEdit = (setting: SystemSetting) => {
    setEditingKey(setting.setting_key);
    setEditingValue(setting.setting_value);
  };

  const handleSaveInline = (key: string) => {
    onUpdateSetting(key, editingValue);
    setEditingKey(null);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newValue.trim()) return;
    onUpdateSetting(newKey.trim().toLowerCase().replace(/\s+/g, '_'), newValue.trim());
    setIsAddModalOpen(false);
    setNewKey('');
    setNewValue('');
  };

  const getSettingIcon = (key: string) => {
    if (key.includes('temp')) return <Thermometer className="w-5 h-5 text-rose-400" />;
    if (key.includes('noise') || key.includes('audio')) return <Volume2 className="w-5 h-5 text-indigo-400" />;
    if (key.includes('motion')) return <Activity className="w-5 h-5 text-emerald-400" />;
    if (key.includes('alert') || key.includes('sms')) return <Bell className="w-5 h-5 text-amber-400" />;
    return <Sliders className="w-5 h-5 text-blue-400" />;
  };

  const formatKeyLabel = (key: string) => {
    return key
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  return (
    <div className="system-settings-view">
      {/* Header */}
      <div className="view-header">
        <div>
          <h2 className="view-title">System Settings & Thresholds</h2>
          <p className="view-subtitle">Configure automated alarm triggers, noise limits, and environmental parameters</p>
        </div>
        <div className="view-header-actions">
          {onResetDefaults && (
            <button className="secondary-btn" onClick={onResetDefaults}>
              <RotateCcw className="btn-icon" /> Reset Defaults
            </button>
          )}
          <button className="primary-btn" onClick={() => setIsAddModalOpen(true)}>
            <Plus className="btn-icon" /> Add New Setting
          </button>
        </div>
      </div>

      {/* Settings Grid */}
      <div className="settings-grid">
        {settings.map((setting) => {
          const isEditing = editingKey === setting.setting_key;

          return (
            <div key={setting.id} className="setting-card">
              <div className="setting-card-header">
                <div className="setting-icon-box">
                  {getSettingIcon(setting.setting_key)}
                </div>
                <div className="setting-title-box">
                  <h4 className="setting-key">{formatKeyLabel(setting.setting_key)}</h4>
                  <span className="setting-raw-key">{setting.setting_key}</span>
                </div>
              </div>

              <div className="setting-card-body">
                {isEditing ? (
                  <div className="setting-edit-box">
                    <input
                      type="text"
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      className="setting-input"
                      autoFocus
                    />
                    <div className="setting-edit-actions">
                      <button 
                        className="save-mini-btn" 
                        onClick={() => handleSaveInline(setting.setting_key)}
                      >
                        <Check className="w-4 h-4 mr-1 inline" /> Save
                      </button>
                      <button 
                        className="cancel-mini-btn" 
                        onClick={() => setEditingKey(null)}
                      >
                        <X className="w-4 h-4 inline" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="setting-value-display">
                    <span className="setting-value">{setting.setting_value}</span>
                    <button className="edit-setting-btn" onClick={() => startEdit(setting)}>
                      Edit Value
                    </button>
                  </div>
                )}
              </div>

              <div className="setting-card-footer">
                <span className="setting-updated">
                  Updated: {new Date(setting.updated_at).toLocaleString()}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Preset Quick Actions Info */}
      <div className="info-box-card mt-6">
        <Info className="w-5 h-5 text-indigo-400 mr-3 flex-shrink-0" />
        <div>
          <h4 className="text-sm font-semibold text-slate-200">Database Schema Synchronization</h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Settings are stored as key-value pairs in the <code className="text-rose-300">system_settings</code> table. Any update saved here is synchronized directly with your Supabase backend or local database store.
          </p>
        </div>
      </div>

      {/* Add New Setting Modal */}
      {isAddModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsAddModalOpen(false)}>
          <div className="modal-content form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <h3 className="modal-title">Add System Setting</h3>
              </div>
              <button className="close-btn" onClick={() => setIsAddModalOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddSubmit}>
              <div className="modal-body form-grid">
                <div className="form-group full-width">
                  <label className="form-label">Setting Key Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. humidity_threshold_high"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    className="form-input"
                  />
                  <span className="text-xs text-slate-400 mt-1">Will be formatted as a unique database key</span>
                </div>

                <div className="form-group full-width">
                  <label className="form-label">Setting Value</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 70.0 or Enabled"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    className="form-input"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setIsAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn">
                  Add Setting Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
