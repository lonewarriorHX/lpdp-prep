-- ============================================================================
-- LPDP Prep — Payments (Midtrans) + profile pro fields
-- Run this AFTER schema.sql.
-- ============================================================================

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  order_id text unique not null,
  plan text not null,
  amount_idr int not null,
  currency text default 'IDR',
  status text not null default 'pending',
  gateway text default 'midtrans',
  gateway_transaction_id text,
  payment_type text,
  raw_notification jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists payments_user_idx on public.payments(user_id);
create index if not exists payments_status_idx on public.payments(status);

-- Pro fields on profiles
alter table public.profiles
  add column if not exists pro_plan text,
  add column if not exists pro_started_at timestamptz,
  add column if not exists pro_expires_at timestamptz;

-- RLS: users see their own payments only; webhook bypasses via service role
alter table public.payments enable row level security;

drop policy if exists "payments_select_own" on public.payments;
drop policy if exists "payments_insert_own" on public.payments;

create policy "payments_select_own" on public.payments
  for select using (auth.uid() = user_id);
create policy "payments_insert_own" on public.payments
  for insert with check (auth.uid() = user_id);
-- Updates only via service role (webhook). No update policy → blocked for users.

-- Auto-touch updated_at
create or replace function public.touch_payments_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists payments_touch on public.payments;
create trigger payments_touch
  before update on public.payments
  for each row execute function public.touch_payments_updated_at();
