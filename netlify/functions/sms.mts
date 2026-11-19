// =====================================================================
// /api/sms  -  lets the WEBSITE send SMS through Semaphore.
//  - Online: runs as a Netlify Function (key in Netlify -> Site settings -> Environment variables)
//  - npm run dev: vite.config.ts serves the same handler (key in the project .env)
// Env: SEMAPHORE_API_KEY, SEMAPHORE_SENDER (optional), VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
// Recipients = active contacts in Supabase (same as the Pi). Every send is logged in sms_logs.
// Same message wording + phone rules as pi/app.py.
// =====================================================================

type Kind = 'test' | 'sim_heat' | 'sim_no_motion' | 'sim_audio' | 'sim_upload' | 'custom';

interface SmsRequest {
  kind: Kind;
  message?: string;                // custom only
  coughs?: number;                 // sim_upload: result of the Cough Tester
  best?: number;                   // sim_upload: best cough score 0..1
  file?: string;                   // sim_upload: uploaded file name
}

const SEMAPHORE_URL = 'https://api.semaphore.co/api/v4/messages';

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function normalizePhNumber(raw: unknown): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('63') && d.length === 12) d = '0' + d.slice(2);
  else if (d.startsWith('9') && d.length === 10) d = '0' + d;
  return d.startsWith('09') && d.length === 11 ? d : null;
}

function stamp(): string {
  return new Date()
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })
    .replace(' ', '')
    .toLowerCase();
}

function buildMessage(req: SmsRequest): string {
  const t = stamp();
  switch (req.kind) {
    case 'test':
      return `Pig Monitor: SMS alerts are working. You will get alerts here. ${t}`;
    case 'sim_heat':
      return `[SIMULATION] PIG ALERT: HEAT 40.0C (limit 38C). Cooling water ON, cycle 1. ${t}`;
    case 'sim_no_motion':
      return `[SIMULATION] PIG ALERT: pigs have not moved for 120 min (3 seen on camera). Please check. ${t}`;
    case 'sim_audio':
      return `[SIMULATION] PIG ALERT: 3 cough / 0 stress sound(s) in the last 60s (Coughing / Sneezing). ${t}`;
    case 'sim_upload': {
      const n = Math.max(1, Math.min(999, Math.round(Number(req.coughs) || 1)));
      const best = Math.round(Math.max(0, Math.min(1, Number(req.best) || 0)) * 100);
      const file = String(req.file ?? 'audio').replace(/[^\w .()-]/g, '').slice(0, 40) || 'audio';
      return `[SIMULATION] PIG ALERT: ${n} cough${n === 1 ? '' : 's'} detected in "${file}" (best ${best}%). Please check the pigs. ${t}`;
    }
    case 'custom': {
      const m = String(req.message ?? '').trim().slice(0, 300);
      if (!m) throw new Error('Message is empty');
      if (/^test/i.test(m)) throw new Error('Semaphore silently drops messages that start with "TEST". Reword it.');
      return m;
    }
    default:
      throw new Error('Unknown SMS kind');
  }
}

async function supabase(path: string, init: RequestInit = {}) {
  const url = env('VITE_SUPABASE_URL') || env('SUPABASE_URL');
  const key = env('VITE_SUPABASE_ANON_KEY') || env('SUPABASE_KEY');
  if (!url || !key) throw new Error('Supabase URL / anon key missing in env');
  return fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  let kind: Kind = 'custom';
  let message = '';
  let numbers: string[] = [];
  let status: 'sent' | 'failed' = 'failed';
  let error: string | null = null;
  let providerResponse: string | null = null;

  try {
    const body = (await request.json()) as SmsRequest;
    kind = body.kind;
    message = buildMessage(body);

    const apiKey = env('SEMAPHORE_API_KEY');
    if (!apiKey) throw new Error('SEMAPHORE_API_KEY is not set for the website');

    const res = await supabase('contacts?select=name,phone_number&is_active=eq.true');
    if (!res.ok) throw new Error(`Could not read contacts (HTTP ${res.status})`);
    const contacts = (await res.json()) as { name: string; phone_number: string }[];
    numbers = [...new Set(contacts.map((c) => normalizePhNumber(c.phone_number)).filter((n): n is string => !!n))].sort();
    if (numbers.length === 0) throw new Error('No active contacts with a valid PH mobile number');

    const form = new URLSearchParams({ apikey: apiKey, number: numbers.join(','), message });
    const sender = env('SEMAPHORE_SENDER');
    if (sender) form.set('sendername', sender);
    const sem = await fetch(SEMAPHORE_URL, { method: 'POST', body: form });
    const fullText = await sem.text();                  // parse the WHOLE reply, keep only 500 chars for the log
    providerResponse = fullText.slice(0, 500);
    if (!sem.ok) throw new Error(`Semaphore HTTP ${sem.status}: ${providerResponse.slice(0, 200)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fullText);
    } catch {
      throw new Error(`Semaphore answered: ${providerResponse.slice(0, 200)}`);
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (!items.some((i) => i && typeof i === 'object' && 'message_id' in i)) {
      throw new Error(`Semaphore did not accept it: ${providerResponse.slice(0, 200)}`);
    }
    status = 'sent';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Log it like the Pi does (alert_type gets a "web_" prefix so you can tell them apart)
  try {
    await supabase('sms_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        alert_type: `web_${kind}`,
        message,
        numbers: numbers.join(','),
        status,
        error,
        provider_response: providerResponse,
      }),
    });
  } catch {
    /* logging is best-effort */
  }

  return json(status === 'sent' ? 200 : 400, { ok: status === 'sent', status, error, numbers, message });
}

// Netlify: serve this at /api/sms (takes priority over the SPA redirect in netlify.toml)
export const config = { path: '/api/sms' };
