-- ============================================================================
-- SIAP Studi — Reference interview questions used as few-shot seeds for the AI
-- Run this AFTER schema.sql.
-- ============================================================================

create table if not exists public.reference_questions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete set null,
  question text not null,
  focus text,           -- Clarity | Motivation | Confidence | Alignment | Impact | Relevance
  language text not null default 'id' check (language in ('id', 'en')),
  notes text,
  tags text[],
  created_at timestamptz default now()
);

create index if not exists reference_questions_lang_idx on public.reference_questions(language);
create index if not exists reference_questions_created_idx on public.reference_questions(created_at desc);

alter table public.reference_questions enable row level security;

drop policy if exists "ref_questions_public_read" on public.reference_questions;
drop policy if exists "ref_questions_insert_auth" on public.reference_questions;
drop policy if exists "ref_questions_delete_own" on public.reference_questions;
drop policy if exists "ref_questions_update_own" on public.reference_questions;

create policy "ref_questions_public_read" on public.reference_questions
  for select using (true);
create policy "ref_questions_insert_auth" on public.reference_questions
  for insert with check (auth.uid() = user_id);
create policy "ref_questions_update_own" on public.reference_questions
  for update using (auth.uid() = user_id);
create policy "ref_questions_delete_own" on public.reference_questions
  for delete using (auth.uid() = user_id);
