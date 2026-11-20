// SMS helpers for the website. Phone rules are the same as normalize_ph_number() in pi/app.py.

/** '+63 912 345 6789' / '0912-345-6789' / '9123456789' -> '09123456789', or null if not a PH mobile number. */
export function normalizePhNumber(raw: string | null | undefined): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('63') && d.length === 12) d = '0' + d.slice(2);
  else if (d.startsWith('9') && d.length === 10) d = '0' + d;
  return d.startsWith('09') && d.length === 11 ? d : null;
}

export const SMS_TYPE_LABEL: Record<string, string> = {
  // sent by the Pi
  heat: 'Heat',
  heat_ok: 'Heat OK',
  no_motion: 'Not moving',
  no_motion_ok: 'Moving again',
  audio: 'Cough / stress',
  test: 'Test (Pi)',
  // sent from the website (/api/sms)
  web_test: 'Test (web)',
  web_sim_heat: 'Sim: heat',
  web_sim_no_motion: 'Sim: not moving',
  web_sim_audio: 'Sim: cough',
  web_sim_upload: 'Tester: cough',
  web_custom: 'Message',
};

export type WebSmsKind = 'test' | 'sim_heat' | 'sim_no_motion' | 'sim_audio' | 'sim_upload' | 'custom';

export interface WebSmsResult {
  ok: boolean;
  error: string | null;
  numbers: string[];
  message: string;
}

/** Sends through /api/sms (or /.netlify/functions/sms fallback on Netlify). */
export async function sendSmsFromWeb(
  kind: WebSmsKind,
  message?: string,
  extra?: { coughs?: number; best?: number; file?: string },
): Promise<WebSmsResult> {
  const payload = JSON.stringify({ kind, message, ...extra });
  const endpoints = ['/api/sms', '/.netlify/functions/sms'];
  let lastStatus = 0;

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      lastStatus = res.status;
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as WebSmsResult;
        if (parsed && typeof parsed.ok === 'boolean') {
          return parsed;
        }
      } catch {
        // Endpoint returned HTML (SPA fallback) or non-JSON; try next endpoint
      }
    } catch (e) {
      if (endpoint === endpoints[endpoints.length - 1]) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), numbers: [], message: '' };
      }
    }
  }

  return {
    ok: false,
    error: `SMS endpoint not available (HTTP ${lastStatus}). Redeploy the latest build to Netlify.`,
    numbers: [],
    message: '',
  };
}
