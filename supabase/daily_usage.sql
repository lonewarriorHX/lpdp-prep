-- ============================================================================
-- SIAP Studi — Daily usage limits
-- Tracks per-user, per-action daily usage so the app can enforce caps.
--
-- Free:  3 essay checks/day
-- Pro:  10 essay checks/day
-- Run AFTER schema.sql + pro_tier.sql.
-- ============================================================================

create table if not exists public.usage_log (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid not null references auth.users on delete cascade,
  action      text not null check (action in ('essay_check', 'interview_session')),
  created_at  timestamptz not null default now()
);

create index if not exists usage_log_user_action_day_idx
  on public.usage_log (user_id, action, created_at);

alter table public.usage_log enable row level security;

drop policy if exists "usage_log_select_own" on public.usage_log;
drop policy if exists "usage_log_insert_own" on public.usage_log;
create policy "usage_log_select_own" on public.usage_log
  for select using (auth.uid() = user_id);
create policy "usage_log_insert_own" on public.usage_log
  for insert with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Get today's usage count for a given action for the calling user.
-- "Today" = same calendar day in Asia/Jakarta (LPDP target audience).
-- ----------------------------------------------------------------------------
create or replace function public.get_today_usage(p_action text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    return 0;
  end if;
  select count(*)::int into v_count
    from public.usage_log
   where user_id = auth.uid()
     and action  = p_action
     and (created_at at time zone 'Asia/Jakarta')::date
       = (now()        at time zone 'Asia/Jakarta')::date;
  return coalesce(v_count, 0);
end;
$$;

-- ----------------------------------------------------------------------------
-- Atomically check the daily cap, then record one use if allowed.
-- Returns: { allowed boolean, used int, limit int, remaining int, is_pro bool }
-- ----------------------------------------------------------------------------
create or replace function public.check_and_record_usage(p_action text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid := auth.uid();
  v_is_pro    boolean := false;
  v_limit     integer;
  v_used      integer;
  v_allowed   boolean;
begin
  if v_user_id is null then
    return json_build_object(
      'allowed', false, 'used', 0, 'limit', 0, 'remaining', 0,
      'is_pro', false, 'error', 'not_authenticated'
    );
  end if;

  select coalesce(is_pro, false) into v_is_pro
    from public.profiles where id = v_user_id;

  if p_action = 'essay_check' then
    v_limit := case when v_is_pro then 10 else 3 end;
  else
    -- Unknown action -> no enforced cap, but still record
    v_limit := 999999;
  end if;

  -- Serialize concurrent calls for the same (user, action) pair so two parallel
  -- requests can't both pass the cap check. Lock auto-releases at transaction end.
  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text || '|' || p_action, 0)
  );

  -- Count today's usage (Asia/Jakarta day boundary)
  select count(*)::int into v_used
    from public.usage_log
   where user_id = v_user_id
     and action  = p_action
     and (created_at at time zone 'Asia/Jakarta')::date
       = (now()        at time zone 'Asia/Jakarta')::date;

  v_allowed := v_used < v_limit;

  if v_allowed then
    insert into public.usage_log (user_id, action) values (v_user_id, p_action);
    v_used := v_used + 1;
  end if;

  return json_build_object(
    'allowed',   v_allowed,
    'used',      v_used,
    'limit',     v_limit,
    'remaining', greatest(0, v_limit - v_used),
    'is_pro',    v_is_pro
  );
end;
$$;

grant execute on function public.get_today_usage(text)        to authenticated;
grant execute on function public.check_and_record_usage(text) to authenticated;
