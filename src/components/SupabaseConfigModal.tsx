import React, { useState } from 'react';
import { 
  getStoredSupabaseConfig, 
  saveSupabaseConfig, 
  resetSupabaseClient 
} from '../lib/supabase';
import { Database, Key, Check, Copy, X, ExternalLink, Code } from 'lucide-react';

interface SupabaseConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRefreshData: () => void;
}

export const SupabaseConfigModal: React.FC<SupabaseConfigModalProps> = ({
  isOpen,
  onClose,
  onRefreshData,
}) => {
  if (!isOpen) return null;

  const currentConfig = getStoredSupabaseConfig();
  const [url, setUrl] = useState(currentConfig.url || 'https://rembfnigpvtuxoyjjexf.supabase.co');
  const [anonKey, setAnonKey] = useState(currentConfig.anonKey || '');
  const [copiedSql, setCopiedSql] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const sqlSchema = `-- Pig Monitoring System PostgreSQL Schema (Supabase)

CREATE TABLE public.sensor_logs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  ambient_temp numeric,
  floor_temp numeric,
  motion_detected boolean,
  audio_level integer,
  image_url text,
  audio_url text,
  CONSTRAINT sensor_logs_pkey PRIMARY KEY (id)
);

CREATE TABLE public.system_settings (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  setting_key text NOT NULL UNIQUE,
  setting_value text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT system_settings_pkey PRIMARY KEY (id)
);

CREATE TABLE public.contacts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  name text NOT NULL,
  phone_number text NOT NULL,
  is_active boolean DEFAULT true,
  CONSTRAINT contacts_pkey PRIMARY KEY (id)
);`;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveSupabaseConfig(url.trim(), anonKey.trim());
    resetSupabaseClient();
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onRefreshData();
      onClose();
    }, 800);
  };

  const copySql = () => {
    navigator.clipboard.writeText(sqlSchema);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content config-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="flex items-center space-x-2">
            <Database className="w-5 h-5 text-emerald-400" />
            <h3 className="modal-title">Supabase Database Connection</h3>
          </div>
          <button className="close-btn" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="modal-body space-y-4">
            <div className="form-group">
              <label className="form-label flex items-center justify-between">
                <span>Supabase Project URL</span>
                <a 
                  href="https://supabase.com/dashboard/project/rembfnigpvtuxoyjjexf" 
                  target="_blank" 
                  rel="noreferrer"
                  className="text-xs text-emerald-400 hover:underline inline-flex items-center"
                >
                  Open Supabase Dashboard <ExternalLink className="w-3 h-3 ml-1" />
                </a>
              </label>
              <div className="input-with-icon">
                <Database className="input-icon" />
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://rembfnigpvtuxoyjjexf.supabase.co"
                  className="form-input icon-padded"
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label flex items-center justify-between">
                <span>Supabase Anon (Public) Key</span>
                <span className="text-xs text-slate-400">Found under Project Settings &gt; API</span>
              </label>
              <div className="input-with-icon">
                <Key className="input-icon" />
                <input
                  type="password"
                  value={anonKey}
                  onChange={(e) => setAnonKey(e.target.value)}
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  className="form-input icon-padded"
                />
              </div>
              <span className="text-xs text-slate-400 mt-1 block">
                Leave key blank to run in <strong>Interactive Demo Mode</strong> with local state.
              </span>
            </div>

            {/* SQL Copy Snippet Box */}
            <div className="sql-box-wrapper">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-300 flex items-center">
                  <Code className="w-3.5 h-3.5 mr-1 text-indigo-400" /> Database SQL Schema
                </span>
                <button type="button" className="copy-sql-btn" onClick={copySql}>
                  {copiedSql ? <Check className="w-3 h-3 mr-1 text-emerald-400 inline" /> : <Copy className="w-3 h-3 mr-1 inline" />}
                  {copiedSql ? 'Copied SQL!' : 'Copy SQL Schema'}
                </button>
              </div>
              <pre className="sql-snippet-code">{sqlSchema}</pre>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="primary-btn">
              {savedSuccess ? <Check className="w-4 h-4 mr-1 text-emerald-400 inline" /> : null}
              {savedSuccess ? 'Saved & Connected!' : 'Save & Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
