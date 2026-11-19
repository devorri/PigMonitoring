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

-- 2. Settings the Pi reads / writes (only added if missing)
insert into public.system_settings (setting_key, setting_value)
select v.k, v.v from (values
  ('cam_live_enabled', 'true'),
  ('cam_live_interval_seconds', '3'),   -- 2..60, the Pi needs ~1s per frame for YOLO
  ('cam_flash', 'off'),                 -- off | on | night
  ('cam_status', ''),                   -- written by the Pi (camera + vision health)
  ('pi_status', ''),                    -- written by the Pi (CPU temp, memory, audio)
  ('cough_alert_min', '2'),             -- coughs per audio interval before ATTENTION NEEDED (1..10)
  ('audio_ref_db', '-18')               -- loudness every 1s window is leveled to before the AI (-30..-6)
) as v(k, v)
where not exists (select 1 from public.system_settings s where s.setting_key = v.k);

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
