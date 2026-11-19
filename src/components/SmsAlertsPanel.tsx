import React, { useState } from 'react';
import {
  MessageSquare,
  Send,
  Settings,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Thermometer,
  Activity,
  HeartPulse,
  Cpu,
  Loader2,
} from 'lucide-react';
import type { Contact, SmsLog, SystemSetting } from '../types';
import { settingNumber, settingValue } from '../lib/settingsSpec';
import { SMS_TYPE_LABEL, normalizePhNumber, sendSmsFromWeb, type WebSmsKind } from '../lib/sms';

interface SmsAlertsPanelProps {
  settings: SystemSetting[];
  contacts: Contact[];
  smsLogs: SmsLog[];
  onUpdateSetting: (key: string, value: string) => void;
  onOpenSettings: () => void;
}

const fmtHour = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'AM' : 'PM'}`;

type Result = { ok: boolean; text: string } | null;

export const SmsAlertsPanel: React.FC<SmsAlertsPanelProps> = ({
  settings,
  contacts,
  smsLogs,
  onUpdateSetting,
  onOpenSettings,
}) => {
  const [busy, setBusy] = useState<WebSmsKind | 'pi_test' | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [piTestAt, setPiTestAt] = useState<number | null>(null);
  const [custom, setCustom] = useState('');

  const enabled = settingValue(settings, 'sms_enabled') === 'true';
  const interval = settingNumber(settings, 'sms_interval_minutes');
  const trigger = settingNumber(settings, 'solenoid_trigger_temp');
  const stillMin = settingNumber(settings, 'sms_no_motion_minutes');
  const fromH = settingNumber(settings, 'sms_motion_start_hour');
  const toH = settingNumber(settings, 'sms_motion_end_hour');
  const on = (k: string) => settingValue(settings, k) === 'true';

  const active = contacts.filter((c) => c.is_active);
  const valid = active.filter((c) => normalizePhNumber(c.phone_number));
  const invalid = active.filter((c) => !normalizePhNumber(c.phone_number));

  const rules = [
    on('sms_on_heat') && `Heat ≥ ${trigger}°C`,
    on('sms_on_no_motion') && `Not moving ${stillMin} min (${fmtHour(fromH)}–${fmtHour(toH)})`,
    on('sms_on_audio') && 'Cough / stress',
    on('sms_send_recovery') && 'Back to normal',
  ].filter(Boolean) as string[];

  const piTestResult = piTestAt
    ? smsLogs.find((l) => l.alert_type === 'test' && new Date(l.created_at).getTime() >= piTestAt - 5000)
    : undefined;

  const send = async (kind: WebSmsKind, message?: string) => {
    setBusy(kind);
    setResult(null);
    const r = await sendSmsFromWeb(kind, message);
    setResult(
      r.ok
        ? { ok: true, text: `Sent to ${r.numbers.length} contact${r.numbers.length === 1 ? '' : 's'}: "${r.message}"` }
        : { ok: false, text: `Failed: ${r.error}` },
    );
    if (r.ok && kind === 'custom') setCustom('');
    setBusy(null);
  };

  const testViaPi = () => {
    const now = Date.now();
    setPiTestAt(now);
    setResult(null);
    onUpdateSetting('sms_test_request', new Date(now).toISOString());
  };

  const noRecipients = valid.length === 0;

  return (
    <div className="glass-panel sms-panel">
      <div className="sms-head">
        <div className="sms-title">
          <div className="kpi-icon-circle pink">
            <MessageSquare style={{ width: 18, height: 18 }} />
          </div>
          <div>
            <h3 className="panel-title">SMS alerts</h3>
            <p className="panel-subtitle">
              The Pi texts every active contact below when something is wrong. You can also send from here.
            </p>
          </div>
        </div>
        <div className="sms-actions">
          <span className={`kpi-badge ${enabled ? 'green' : 'neutral'}`}>Auto alerts {enabled ? 'ON' : 'OFF'}</span>
          <button
            className={enabled ? 'secondary-btn' : 'primary-btn'}
            onClick={() => onUpdateSetting('sms_enabled', enabled ? 'false' : 'true')}
          >
            {enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button className="secondary-btn" onClick={onOpenSettings} title="Change SMS rules and interval">
            <Settings className="btn-icon" /> Rules
          </button>
        </div>
      </div>

      <div className="sms-rules">
        <span className="kpi-badge neutral">Re-send every {interval} min while it lasts</span>
        {rules.length ? (
          rules.map((r) => (
            <span key={r} className="kpi-badge neutral">
              {r}
            </span>
          ))
        ) : (
          <span className="kpi-badge amber">No alert types turned on</span>
        )}
        <span className={`kpi-badge ${valid.length ? 'green' : 'amber'}`}>
          {valid.length} recipient{valid.length === 1 ? '' : 's'}
        </span>
      </div>

      {invalid.length > 0 && (
        <div className="sms-note warn">
          <AlertTriangle className="btn-icon" />
          Won't receive SMS (not a PH mobile number): {invalid.map((c) => `${c.name} (${c.phone_number})`).join(', ')}
        </div>
      )}

      {/* Send / simulate */}
      <div className="sms-tools">
        <div className="sms-tools-row">
          <span className="sms-tools-label">Test</span>
          <button className="primary-btn" disabled={!!busy || noRecipients} onClick={() => send('test')}>
            {busy === 'test' ? <Loader2 className="btn-icon at-spin" /> : <Send className="btn-icon" />} Send test SMS
          </button>
          <button className="secondary-btn" disabled={!!busy || noRecipients} onClick={testViaPi} title="The Pi sends it within ~10s">
            <Cpu className="btn-icon" /> Test through the Pi
          </button>
        </div>
        <div className="sms-tools-row">
          <span className="sms-tools-label">Simulate</span>
          <button className="secondary-btn" disabled={!!busy || noRecipients} onClick={() => send('sim_heat')}>
            {busy === 'sim_heat' ? <Loader2 className="btn-icon at-spin" /> : <Thermometer className="btn-icon" />} Heat
          </button>
          <button className="secondary-btn" disabled={!!busy || noRecipients} onClick={() => send('sim_no_motion')}>
            {busy === 'sim_no_motion' ? <Loader2 className="btn-icon at-spin" /> : <Activity className="btn-icon" />} Not moving
          </button>
          <button className="secondary-btn" disabled={!!busy || noRecipients} onClick={() => send('sim_audio')}>
            {busy === 'sim_audio' ? <Loader2 className="btn-icon at-spin" /> : <HeartPulse className="btn-icon" />} Cough / stress
          </button>
        </div>
        <form
          className="sms-tools-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) void send('custom', custom);
          }}
        >
          <span className="sms-tools-label">Message</span>
          <input
            className="search-input sms-input"
            placeholder="Type a message to all active contacts…"
            maxLength={300}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button className="secondary-btn" type="submit" disabled={!!busy || noRecipients || !custom.trim()}>
            {busy === 'custom' ? <Loader2 className="btn-icon at-spin" /> : <Send className="btn-icon" />} Send
          </button>
        </form>
        <p className="sms-hint">
          Simulations are marked [SIMULATION] and don't touch the relays. Each SMS uses Semaphore credits.
        </p>
      </div>

      {result && <div className={`sms-note ${result.ok ? '' : 'warn'}`}>{result.text}</div>}
      {piTestAt && (
        <div className={`sms-note ${piTestResult?.status === 'failed' ? 'warn' : ''}`}>
          {piTestResult
            ? piTestResult.status === 'sent'
              ? `Pi test SMS sent to ${piTestResult.numbers}.`
              : `Pi test SMS failed: ${piTestResult.error}`
            : 'Test requested from the Pi. It sends it within about 10 seconds…'}
        </div>
      )}

      <div className="sms-log">
        <div className="sms-log-head">Recent SMS</div>
        {smsLogs.length === 0 ? (
          <div className="sms-empty">No SMS sent yet.</div>
        ) : (
          smsLogs.slice(0, 10).map((l) => {
            const type = l.alert_type ?? '';
            const calm = type.endsWith('_ok') || type.includes('test') || type.startsWith('web_sim') || type === 'web_custom';
            return (
              <div key={l.id} className="sms-row">
                {l.status === 'sent' ? (
                  <CheckCircle2 className="btn-icon" style={{ color: '#059669' }} />
                ) : (
                  <XCircle className="btn-icon" style={{ color: '#dc2626' }} />
                )}
                <span className="sms-time">
                  {new Date(l.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={`kpi-badge ${calm ? 'neutral' : 'red'}`}>{SMS_TYPE_LABEL[type] ?? type}</span>
                <span className="sms-msg" title={l.message ?? ''}>
                  {l.status === 'failed' ? `Failed: ${l.error}` : l.message}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
