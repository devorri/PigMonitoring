// =====================================================================
// ONE list of every setting in system_settings.
// The Raspberry Pi (pi/app.py -> SETTINGS_SPEC) and supabase_pi_setup.sql use the
// SAME keys, defaults and limits. If you change one, change all three.
// =====================================================================
import type { SystemSetting } from '../types';

export type SettingKind = 'enum' | 'number' | 'bool' | 'status';
export type SettingOwner = 'pi' | 'web';

export interface SettingSpec {
  key: string;
  label: string;
  kind: SettingKind;
  default: string;
  owner: SettingOwner;          // pi = the Raspberry Pi acts on it, web = website display only
  group: 'Relays' | 'Camera' | 'Audio AI' | 'Timing' | 'SMS alerts' | 'Website alerts' | 'Pi status';
  description: string;
  options?: string[];           // enum
  min?: number;                 // number
  max?: number;
  step?: number;
  unit?: string;
}

export const SETTINGS_SPEC: SettingSpec[] = [
  // --- Relays ---
  { key: 'bulb_mode', label: 'Heating bulb mode', kind: 'enum', options: ['auto', 'on', 'off'], default: 'off', owner: 'pi', group: 'Relays',
    description: 'auto = on between start and end hour. Always forced OFF while heat protection is cooling.' },
  { key: 'bulb_start_hour', label: 'Bulb ON from (hour)', kind: 'number', min: 0, max: 23, step: 1, default: '18', owner: 'pi', group: 'Relays',
    description: '24h clock, used in auto mode.' },
  { key: 'bulb_end_hour', label: 'Bulb OFF at (hour)', kind: 'number', min: 0, max: 23, step: 1, default: '6', owner: 'pi', group: 'Relays',
    description: '24h clock, used in auto mode.' },
  { key: 'solenoid_mode', label: 'Water solenoid mode', kind: 'enum', options: ['auto', 'on', 'off'], default: 'off', owner: 'pi', group: 'Relays',
    description: 'on = always open. auto / off = closed, but heat protection still opens it at the trigger temp.' },
  { key: 'solenoid_trigger_temp', label: 'Heat protection trigger', kind: 'number', min: 25, max: 45, step: 0.5, unit: '°C', default: '38', owner: 'pi', group: 'Relays',
    description: 'Hottest of ambient / floor at or above this -> water 10 min ON, 2 min check, repeat until 1°C below.' },

  // --- Camera ---
  { key: 'cam_live_enabled', label: 'Live camera', kind: 'bool', default: 'true', owner: 'pi', group: 'Camera',
    description: 'Pi uploads live frames with pig detections.' },
  { key: 'cam_live_interval_seconds', label: 'Live frame every', kind: 'number', min: 2, max: 60, step: 1, unit: 's', default: '3', owner: 'pi', group: 'Camera',
    description: 'The Pi 4 needs about 1s per frame for the AI.' },
  { key: 'cam_flash', label: 'Camera flash', kind: 'enum', options: ['off', 'on', 'night'], default: 'off', owner: 'pi', group: 'Camera',
    description: 'night = 6 PM to 6 AM.' },

  // --- Audio AI ---
  { key: 'audio_threshold', label: 'Cough / stress threshold', kind: 'number', min: 0.3, max: 0.95, step: 0.05, default: '0.6', owner: 'pi', group: 'Audio AI',
    description: 'Higher = fewer alerts. Same value the Cough Tester uses.' },
  { key: 'audio_min_db', label: 'Ignore sounds below', kind: 'number', min: 30, max: 90, step: 1, unit: 'dB', default: '50', owner: 'pi', group: 'Audio AI',
    description: 'Quieter seconds are not checked by the AI.' },
  { key: 'cough_alert_min', label: 'Coughs before alert', kind: 'number', min: 1, max: 10, step: 1, default: '2', owner: 'pi', group: 'Audio AI',
    description: 'Coughs in one audio interval before ATTENTION NEEDED.' },
  { key: 'audio_ref_db', label: 'Audio leveling', kind: 'number', min: -30, max: -6, step: 1, unit: 'dBFS', default: '-18', owner: 'pi', group: 'Audio AI',
    description: 'Every 1s window is leveled to this before the AI. Leave at -18 unless told otherwise.' },

  // --- Timing ---
  { key: 'sync_interval_seconds', label: 'Sensor log every', kind: 'number', min: 5, max: 3600, step: 1, unit: 's', default: '15', owner: 'pi', group: 'Timing',
    description: 'How often the Pi saves a sensor_logs row.' },
  { key: 'audio_interval_seconds', label: 'Audio summary every', kind: 'number', min: 10, max: 3600, step: 1, unit: 's', default: '60', owner: 'pi', group: 'Timing',
    description: 'How often the Pi saves an audio_detections row + clip.' },

  // --- SMS alerts (the Pi sends them through Semaphore) ---
  { key: 'sms_enabled', label: 'SMS alerts', kind: 'bool', default: 'false', owner: 'pi', group: 'SMS alerts',
    description: 'Master switch. Recipients = active contacts. The Semaphore API key is stored only on the Pi.' },
  { key: 'sms_interval_minutes', label: 'Re-send every', kind: 'number', min: 1, max: 1440, step: 1, unit: 'min', default: '10', owner: 'pi', group: 'SMS alerts',
    description: 'While a problem lasts, the same alert is sent again at most this often.' },
  { key: 'sms_on_heat', label: 'Heat alert', kind: 'bool', default: 'true', owner: 'pi', group: 'SMS alerts',
    description: 'Text when the hottest of ambient / floor reaches the heat protection trigger.' },
  { key: 'sms_on_no_motion', label: 'Not moving alert', kind: 'bool', default: 'true', owner: 'pi', group: 'SMS alerts',
    description: 'Text when the camera sees pigs but none moved for the time below.' },
  { key: 'sms_no_motion_minutes', label: 'Not moving for', kind: 'number', min: 10, max: 1440, step: 1, unit: 'min', default: '120', owner: 'pi', group: 'SMS alerts',
    description: 'Pigs rest a lot, so keep this long.' },
  { key: 'sms_motion_start_hour', label: 'Check movement from (hour)', kind: 'number', min: 0, max: 23, step: 1, default: '6', owner: 'pi', group: 'SMS alerts',
    description: '24h clock. Outside these hours (night) no "not moving" alerts.' },
  { key: 'sms_motion_end_hour', label: 'Check movement until (hour)', kind: 'number', min: 0, max: 23, step: 1, default: '18', owner: 'pi', group: 'SMS alerts',
    description: '24h clock.' },
  { key: 'sms_on_audio', label: 'Cough / stress alert', kind: 'bool', default: 'true', owner: 'pi', group: 'SMS alerts',
    description: 'Text when the audio AI says ATTENTION NEEDED.' },
  { key: 'sms_send_recovery', label: 'Back to normal SMS', kind: 'bool', default: 'true', owner: 'pi', group: 'SMS alerts',
    description: 'One extra SMS when heat / not moving goes back to normal.' },
  { key: 'sms_test_request', label: 'Last test SMS request', kind: 'status', default: '', owner: 'web', group: 'SMS alerts',
    description: 'Set by the "Send test SMS" button on the Contacts page. The Pi sends a test within ~10s.' },

  // --- Website only ---
  { key: 'temp_threshold_low', label: 'Low temp warning', kind: 'number', min: 0, max: 35, step: 0.5, unit: '°C', default: '18', owner: 'web', group: 'Website alerts',
    description: 'Website warning only (the Pi has no cold logic).' },
  { key: 'noise_alert_level', label: 'High noise warning', kind: 'number', min: 40, max: 110, step: 1, unit: 'dB', default: '75', owner: 'web', group: 'Website alerts',
    description: 'Website warning only.' },

  // --- Written by the Pi (read-only) ---
  { key: 'relay_state', label: 'Relay state', kind: 'status', default: '', owner: 'pi', group: 'Pi status',
    description: 'Real bulb / solenoid / heat protection state. Written by the Pi on every change + every 30s.' },
  { key: 'pi_status', label: 'Pi health', kind: 'status', default: '', owner: 'pi', group: 'Pi status',
    description: 'Written by the Pi every 60s.' },
  { key: 'cam_status', label: 'Camera health', kind: 'status', default: '', owner: 'pi', group: 'Pi status',
    description: 'Written by the Pi every 60s.' },
];

export const SPEC_BY_KEY: Record<string, SettingSpec> = Object.fromEntries(SETTINGS_SPEC.map((s) => [s.key, s]));

/** Keys the Pi writes itself (no toast / no edit). */
export const PI_WRITTEN_KEYS = new Set(SETTINGS_SPEC.filter((s) => s.kind === 'status').map((s) => s.key));

/** Same check the Pi does before it accepts a value. Returns the cleaned value or an error. */
export function validateSetting(key: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const spec = SPEC_BY_KEY[key];
  const v = raw.trim();
  if (!spec) return { ok: true, value: v };
  if (spec.kind === 'status') return { ok: false, error: 'Written by the Pi, read-only' };
  if (spec.kind === 'enum') {
    const low = v.toLowerCase();
    return spec.options!.includes(low) ? { ok: true, value: low } : { ok: false, error: `Use one of: ${spec.options!.join(', ')}` };
  }
  if (spec.kind === 'bool') {
    const low = v.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(low)) return { ok: true, value: 'true' };
    if (['false', '0', 'off', 'no'].includes(low)) return { ok: true, value: 'false' };
    return { ok: false, error: 'Use true or false' };
  }
  let n = Number(v);
  if (key === 'audio_threshold' && n > 1) n /= 100;     // "60" -> 0.6, same as the Pi
  if (v === '' || Number.isNaN(n)) return { ok: false, error: 'Must be a number' };
  if (n < spec.min! || n > spec.max!) return { ok: false, error: `Must be ${spec.min} to ${spec.max}${spec.unit ? ' ' + spec.unit : ''}` };
  if (spec.step === 1 && !Number.isInteger(n)) return { ok: false, error: 'Must be a whole number' };
  return { ok: true, value: String(n) };
}

/** Value the Pi is actually using: the DB value if valid, otherwise the shared default. */
export function settingValue(settings: SystemSetting[], key: string): string {
  const spec = SPEC_BY_KEY[key];
  const row = settings.find((s) => s.setting_key === key);
  if (!spec) return row?.setting_value ?? '';
  if (!row) return spec.default;
  const r = validateSetting(key, row.setting_value ?? '');
  return r.ok ? r.value : spec.default;
}

export function settingNumber(settings: SystemSetting[], key: string): number {
  return Number(settingValue(settings, key));
}

// ---------------------------------------------------------------------
// Pi-written JSON (relay_state)
// ---------------------------------------------------------------------
export interface RelayState {
  bulb: boolean;
  solenoid: boolean;
  bulb_mode: string;
  solenoid_mode: string;
  phase: 'idle' | 'spraying' | 'waiting';
  left: number;
  cycle: number;
  temp: number | null;
  trigger: number;
  t: number;                    // unix seconds on the Pi
}

export const PI_OFFLINE_AFTER_S = 90;

export function parseRelayState(settings: SystemSetting[]): RelayState | null {
  const raw = settings.find((s) => s.setting_key === 'relay_state')?.setting_value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RelayState;
  } catch {
    return null;
  }
}
