-- ============================================================
-- Pig Monitoring System - Supabase setup for the Raspberry Pi engine (pi/app.py)
-- Run once in Supabase Dashboard -> SQL Editor
-- (Safe to run more than once. Run supabase_esp32cam_setup.sql first if you never did.)
-- ============================================================

-- 1. Results from the Pi audio classifier (same table audio_worker.py used)
create table if not exists public.audio_detections (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  sensor_log_id  bigint,
  audio_url      text,
  top_class      text,
  cough_prob     real,
  stress_prob    real,
  cough_events   int default 0,
  stress_events  int default 0,
  status         text            -- 'HEALTHY' or 'ATTENTION NEEDED'
);
alter table public.audio_detections enable row level security;
drop policy if exists "anon read detections"   on public.audio_detections;
drop policy if exists "anon insert detections" on public.audio_detections;
create policy "anon read detections"   on public.audio_detections for select to anon, authenticated using (true);
create policy "anon insert detections" on public.audio_detections for insert to anon, authenticated with check (true);

-- 2. Every setting (only added if missing). SAME keys / defaults / limits as
--    pi/app.py (SETTINGS_SPEC) and src/lib/settingsSpec.ts. Change all three together.
insert into public.system_settings (setting_key, setting_value)
select v.k, v.v from (values
  -- relays (Pi)
  ('bulb_mode', 'off'),                   -- auto | on | off
  ('bulb_start_hour', '18'),              -- 0..23
  ('bulb_end_hour', '6'),                 -- 0..23
  ('solenoid_mode', 'off'),               -- auto | on | off (heat protection works in auto AND off)
  ('solenoid_trigger_temp', '38'),        -- 25..45 C
  -- camera (Pi)
  ('cam_live_enabled', 'true'),           -- true | false
  ('cam_live_interval_seconds', '3'),     -- 2..60
  ('cam_flash', 'off'),                   -- off | on | night
  -- audio AI (Pi + website Cough Tester)
  ('audio_threshold', '0.6'),             -- 0.30..0.95
  ('audio_min_db', '50'),                 -- 30..90
  ('cough_alert_min', '2'),               -- 1..10
  ('audio_ref_db', '-18'),                -- -30..-6
  -- timing (Pi)
  ('sync_interval_seconds', '15'),        -- 5..3600
  ('audio_interval_seconds', '60'),       -- 10..3600
  -- SMS alerts (Pi sends through Semaphore; API key lives ONLY in the Pi's .env)
  ('sms_enabled', 'false'),               -- true | false
  ('sms_interval_minutes', '10'),         -- 1..1440, re-send while a problem lasts
  ('sms_on_heat', 'true'),                -- true | false
  ('sms_on_no_motion', 'true'),           -- true | false
  ('sms_no_motion_minutes', '120'),       -- 10..1440
  ('sms_motion_start_hour', '6'),         -- 0..23 (only check "not moving" in this window)
  ('sms_motion_end_hour', '18'),          -- 0..23
  ('sms_on_audio', 'true'),               -- true | false
  ('sms_send_recovery', 'true'),          -- true | false
  ('sms_test_request', ''),               -- website writes a timestamp -> Pi sends a test SMS
  -- website-only warnings
  ('temp_threshold_low', '18'),           -- 0..35 C
  ('noise_alert_level', '75'),            -- 40..110 dB
  -- written by the Pi (read-only on the website)
  ('relay_state', ''),
  ('pi_status', ''),
  ('cam_status', '')
) as v(k, v)
where not exists (select 1 from public.system_settings s where s.setting_key = v.k);

-- 2b. Old ESP32 / demo keys nothing reads anymore (temp_threshold_high was replaced by
--     solenoid_trigger_temp). Uncomment to clean them out of the Settings page:
-- delete from public.system_settings where setting_key in
--   ('temp_threshold_high', 'motion_sensitivity', 'alert_sms_enabled', 'auto_ventilation_mode');

-- 2b2. updated_at changes on EVERY update (the Pi's PATCH didn't touch it before)
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := timezone('utc'::text, now()); return new; end $$;
drop trigger if exists system_settings_touch on public.system_settings;
create trigger system_settings_touch before update on public.system_settings
  for each row execute function public.touch_updated_at();

-- 2d. Every SMS the Pi sends (or fails to send)
create table if not exists public.sms_logs (
  id                bigserial primary key,
  created_at        timestamptz not null default now(),
  alert_type        text,          -- heat | heat_ok | no_motion | no_motion_ok | audio | test
  message           text,
  numbers           text,          -- comma separated, as sent
  status            text,          -- sent | failed
  error             text,
  provider_response text
);
alter table public.sms_logs enable row level security;
drop policy if exists "anon read sms_logs"   on public.sms_logs;
drop policy if exists "anon insert sms_logs" on public.sms_logs;
create policy "anon read sms_logs"   on public.sms_logs for select to anon, authenticated using (true);
create policy "anon insert sms_logs" on public.sms_logs for insert to anon, authenticated with check (true);
do $$ begin
  alter publication supabase_realtime add table public.sms_logs;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- 2c. Live updates on the website for the Pi's audio results
do $$ begin
  alter publication supabase_realtime add table public.audio_detections;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- 3. The Pi uploads snap/live_0.jpg, snap/live_1.jpg and snap/live.json (overwrites).
--    x-upsert needs SELECT + INSERT + UPDATE on the snap bucket.
--    The old ESP32-CAM already uploaded there, so this usually works as-is.
--    If the Pi log shows 403 "row-level security" on upload, uncomment these:
--
-- create policy "anon select snap" on storage.objects for select to anon using (bucket_id = 'snap');
-- create policy "anon insert snap" on storage.objects for insert to anon with check (bucket_id = 'snap');
-- create policy "anon update snap" on storage.objects for update to anon using (bucket_id = 'snap');
--
--    If the log shows 415 / "mime type not supported" for live.json, the snap bucket only
--    allows images. Fix: Storage -> snap -> Edit bucket -> Allowed MIME types:
--    add application/json (or leave the list empty).
