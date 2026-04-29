-- ============================================================================
-- LPDP Prep — Supabase schema
-- How to apply:
--   1. Create a project at https://supabase.com (free tier is fine)
--   2. In the dashboard: SQL Editor → New Query → paste this file → Run
--   3. Copy your Project URL and anon public key from Settings → API
--   4. Paste them into js/supabase-config.js
-- ============================================================================

-- Profiles (linked 1:1 with auth.users)
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  name text,
  email text,
  created_at timestamptz default now()
);

-- Essay submissions
create table if not exists public.essays (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  essay_type text,
  content text not null,
  overall_score int,
  analysis jsonb,
  created_at timestamptz default now()
);

-- TBS practice sessions
create table if not exists public.tbs_sessions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  category text,
  total_questions int,
  correct int,
  percent int,
  duration_seconds int,
  created_at timestamptz default now()
);

-- Interview practice sessions
create table if not exists public.interview_sessions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  essay_excerpt text,
  questions jsonb,
  answers jsonb,
  overall_score int,
  evaluation jsonb,
  created_at timestamptz default now()
);

-- Indexes for common queries
create index if not exists essays_user_created_idx on public.essays(user_id, created_at desc);
create index if not exists tbs_user_created_idx on public.tbs_sessions(user_id, created_at desc);
create index if not exists interview_user_created_idx on public.interview_sessions(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security — each user only sees their own rows
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.essays enable row level security;
alter table public.tbs_sessions enable row level security;
alter table public.interview_sessions enable row level security;

-- Profiles: self access
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- Essays: self access
drop policy if exists "essays_select_own" on public.essays;
drop policy if exists "essays_insert_own" on public.essays;
drop policy if exists "essays_delete_own" on public.essays;
create policy "essays_select_own" on public.essays for select using (auth.uid() = user_id);
create policy "essays_insert_own" on public.essays for insert with check (auth.uid() = user_id);
create policy "essays_delete_own" on public.essays for delete using (auth.uid() = user_id);

-- TBS: self access
drop policy if exists "tbs_select_own" on public.tbs_sessions;
drop policy if exists "tbs_insert_own" on public.tbs_sessions;
create policy "tbs_select_own" on public.tbs_sessions for select using (auth.uid() = user_id);
create policy "tbs_insert_own" on public.tbs_sessions for insert with check (auth.uid() = user_id);

-- Interviews: self access
drop policy if exists "interviews_select_own" on public.interview_sessions;
drop policy if exists "interviews_insert_own" on public.interview_sessions;
create policy "interviews_select_own" on public.interview_sessions for select using (auth.uid() = user_id);
create policy "interviews_insert_own" on public.interview_sessions for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Auto-create a profile row when a new user signs up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
