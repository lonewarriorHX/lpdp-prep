-- ============================================================================
-- LPDP Prep — Reference (winning) essays for similarity training
-- Run this AFTER schema.sql and universities.sql.
-- ============================================================================

create table if not exists public.reference_essays (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete set null,
  title text,
  author text,
  content text not null,
  language text not null default 'id' check (language in ('id', 'en')),
  degree_level text,
  university_location text,
  university_name text,
  tags text[],
  created_at timestamptz default now()
);

create index if not exists reference_essays_lang_idx on public.reference_essays(language);
create index if not exists reference_essays_created_idx on public.reference_essays(created_at desc);

-- RLS: public read (so analysis can run even without login);
-- authenticated users can manage their own uploads.
alter table public.reference_essays enable row level security;

drop policy if exists "ref_essays_public_read" on public.reference_essays;
drop policy if exists "ref_essays_insert_auth" on public.reference_essays;
drop policy if exists "ref_essays_delete_own" on public.reference_essays;
drop policy if exists "ref_essays_update_own" on public.reference_essays;

create policy "ref_essays_public_read" on public.reference_essays
  for select using (true);
create policy "ref_essays_insert_auth" on public.reference_essays
  for insert with check (auth.uid() = user_id);
create policy "ref_essays_update_own" on public.reference_essays
  for update using (auth.uid() = user_id);
create policy "ref_essays_delete_own" on public.reference_essays
  for delete using (auth.uid() = user_id);
