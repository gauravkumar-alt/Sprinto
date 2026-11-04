-- Sprinto Outreach Agent — read-only results for the public site (Vercel).
-- Run once in Supabase: SQL Editor → New query → paste → Run.

create table if not exists public.showroom_snapshot (
  id smallint primary key default 1 check (id = 1),   -- exactly one row: the latest results
  generated_at timestamptz not null default now(),
  payload jsonb not null                               -- email addresses already partly masked
);

alter table public.showroom_snapshot enable row level security;

-- Anyone (the public site, using the anon key) may READ the latest results.
drop policy if exists "public can read showroom" on public.showroom_snapshot;
create policy "public can read showroom" on public.showroom_snapshot
  for select to anon, authenticated using (true);

-- No insert/update/delete policy exists, so the anon key cannot change anything.
-- Your Mac publishes with the service_role key, which bypasses RLS and stays in .env.local only.
revoke insert, update, delete on public.showroom_snapshot from anon, authenticated;
