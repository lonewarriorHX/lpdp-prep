-- ============================================================
-- AI Providers — admin-managed LLM API connections
-- ============================================================
-- Supports two provider types:
--   1. openai_compatible  — OpenAI, OpenRouter, Groq, Together, local LLMs, etc.
--   2. anthropic          — Anthropic Messages API (Claude)
--
-- Edge Functions read this table (via service role) to route LLM calls.
-- Only super-admin users can manage providers through the admin panel.
--
-- Run this AFTER schema.sql (needs profiles table).
-- ============================================================

-- 1. Add is_admin flag to profiles (super-admin gate) --------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;

-- 2. AI providers table --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  provider_type   text NOT NULL CHECK (provider_type IN ('openai_compatible', 'anthropic')),
  api_base_url    text NOT NULL,
  api_key         text NOT NULL,
  model           text NOT NULL,
  is_active       boolean DEFAULT true,
  priority        integer DEFAULT 0,          -- lower = tried first
  max_tokens      integer DEFAULT 2500,
  temperature     numeric(3,2) DEFAULT 0.30,
  extra_headers   jsonb DEFAULT '{}',         -- e.g. {"HTTP-Referer":"...", "X-Title":"..."}
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_ai_providers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_providers_updated ON public.ai_providers;
CREATE TRIGGER trg_ai_providers_updated
  BEFORE UPDATE ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION update_ai_providers_updated_at();

-- 3. RLS -----------------------------------------------------------------
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;

-- Admin can do everything
CREATE POLICY "admin_all_ai_providers" ON public.ai_providers
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
  );

-- Service role (Edge Functions) bypasses RLS automatically.

-- 4. Helper: promote a user to admin ------------------------------------
CREATE OR REPLACE FUNCTION public.set_admin_by_email(p_email text, p_admin boolean DEFAULT true)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.profiles
  SET is_admin = p_admin
  WHERE id = (SELECT id FROM auth.users WHERE email = p_email LIMIT 1);
$$;

-- Usage:
--   SELECT public.set_admin_by_email('admin@example.com', true);
--   SELECT public.set_admin_by_email('user@example.com', false);
