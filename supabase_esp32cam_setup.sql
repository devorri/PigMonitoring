-- ============================================================
-- Pig Monitoring System - Supabase setup for ESP32-CAM + audio AI
-- Run once in Supabase Dashboard -> SQL Editor
-- ============================================================

-- 1. Alert snapshots taken by the ESP32-CAM
create table if not exists public.snapshots (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  image_url   text not null,
  reason      text
);
alter table public.snapshots enable row level security;
drop policy if exists "anon read snapshots"   on public.snapshots;
drop policy if exists "anon insert snapshots" on public.snapshots;
create policy "anon read snapshots"   on public.snapshots for select to anon, authenticated using (true);
create policy "anon insert snapshots" on public.snapshots for insert to anon, authenticated with check (true);

-- 2. Results from audio_worker.py (cough / stress model on ESP32 clips)
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

-- 3. New settings (only added if missing)
insert into public.system_settings (setting_key, setting_value)
select v.k, v.v from (values
  ('cam_live_enabled', 'true'),
  ('cam_live_interval_seconds', '2'),
  ('audio_interval_seconds', '60')
) as v(k, v)
where not exists (select 1 from public.system_settings s where s.setting_key = v.k);

-- 4. Storage policies for overwriting files (x-upsert needs SELECT + INSERT + UPDATE).
--    Your audio/snap buckets already have 6 policies each. If uploads still fail with
--    403 "new row violates row-level security policy", uncomment these:
--
-- create policy "anon select audio+snap" on storage.objects for select to anon using (bucket_id in ('audio','snap'));
-- create policy "anon insert audio+snap" on storage.objects for insert to anon with check (bucket_id in ('audio','snap'));
-- create policy "anon update audio+snap" on storage.objects for update to anon using (bucket_id in ('audio','snap'));
