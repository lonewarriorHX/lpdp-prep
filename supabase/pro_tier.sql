-- ============================================================================
-- LPDP Prep — Pro tier flag on profiles
-- Run AFTER schema.sql.
-- ============================================================================

alter table public.profiles
  add column if not exists is_pro boolean not null default false;

-- Convenience: helper to upgrade a user to Pro by email.
--   select public.set_pro_by_email('user@example.com', true);
create or replace function public.set_pro_by_email(p_email text, p_is_pro boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles p
     set is_pro = p_is_pro
   where p.email = p_email;
end;
$$;
