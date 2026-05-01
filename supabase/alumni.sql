-- ============================================================================
-- SIAP Studi — Alumni contributor program
-- Adds is_alumni flag + request fields on profiles + a guard so users
-- cannot self-promote via the public API.
-- Run AFTER schema.sql.
-- ============================================================================

alter table public.profiles
  add column if not exists is_alumni boolean not null default false,
  add column if not exists alumni_status text not null default 'none'
    check (alumni_status in ('none','pending','approved','rejected')),
  add column if not exists alumni_university text,
  add column if not exists alumni_year text,
  add column if not exists alumni_notes text,
  add column if not exists alumni_promo_code text;

create unique index if not exists profiles_alumni_promo_idx
  on public.profiles(alumni_promo_code)
  where alumni_promo_code is not null;

-- ---------------------------------------------------------------------------
-- Guard: users may set alumni_status='pending' (when submitting the request),
-- but cannot self-approve (is_alumni=true, status='approved'/'rejected',
-- or assign their own promo code). Only service_role bypasses this guard.
-- ---------------------------------------------------------------------------
create or replace function public.guard_alumni_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jwt_role text := current_setting('request.jwt.claim.role', true);
begin
  -- jwt_role is NULL when running outside an API request (SQL Editor, psql,
  -- cron jobs, security-definer helpers). It's 'authenticated' or 'anon' when
  -- the request comes from a logged-in user or an unauthenticated client, and
  -- 'service_role' when the service key is used. Only restrict the first two.
  if jwt_role in ('authenticated','anon') then
    new.is_alumni := old.is_alumni;
    new.alumni_promo_code := old.alumni_promo_code;
    if new.alumni_status in ('approved','rejected')
       and old.alumni_status not in ('approved','rejected') then
      new.alumni_status := old.alumni_status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_alumni on public.profiles;
create trigger guard_alumni
  before update on public.profiles
  for each row execute procedure public.guard_alumni_columns();

-- ---------------------------------------------------------------------------
-- Helper for the project owner to approve an alumni in one shot from the
-- Supabase SQL Editor.
--   select public.approve_alumni('user@example.com', 'JANE10');
-- ---------------------------------------------------------------------------
create or replace function public.approve_alumni(
  p_email text,
  p_promo_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set is_alumni = true,
         alumni_status = 'approved',
         alumni_promo_code = coalesce(p_promo_code, alumni_promo_code)
   where email = p_email;
end;
$$;

-- Reject an alumni request (keeps their notes for reference).
--   select public.reject_alumni('user@example.com');
create or replace function public.reject_alumni(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set is_alumni = false,
         alumni_status = 'rejected'
   where email = p_email;
end;
$$;
