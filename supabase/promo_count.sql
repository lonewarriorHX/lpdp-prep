-- ============================================================================
-- SIAP Studi — Public RPC to count promo Pro users
-- Read-only. No effect on payment flow.
-- ============================================================================

create or replace function public.promo_pro_count()
returns int
language sql
security definer
stable
as $$
  select count(*)::int
  from public.payments
  where plan = 'yearly_promo' and status = 'paid';
$$;

grant execute on function public.promo_pro_count() to anon, authenticated;
