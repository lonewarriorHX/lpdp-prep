-- =============================================================================
-- SiapStudi PostgreSQL Schema (self-hosted, no Supabase)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- UTILITY FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- USERS
-- =============================================================================

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- PROFILES
-- =============================================================================

CREATE TABLE profiles (
  id                 UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT,
  email              TEXT,
  is_pro             BOOLEAN     DEFAULT false,
  pro_plan           TEXT,
  pro_started_at     TIMESTAMPTZ,
  pro_expires_at     TIMESTAMPTZ,
  is_alumni          BOOLEAN     DEFAULT false,
  alumni_status      TEXT        DEFAULT 'none' CHECK (alumni_status IN ('none', 'pending', 'approved', 'rejected')),
  alumni_university  TEXT,
  alumni_year        INT,
  alumni_notes       TEXT,
  alumni_promo_code  TEXT,
  is_admin           BOOLEAN     DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- Partial unique index: enforce uniqueness only on non-null promo codes
CREATE UNIQUE INDEX IF NOT EXISTS profiles_alumni_promo_idx
  ON profiles(alumni_promo_code) WHERE alumni_promo_code IS NOT NULL;

CREATE OR REPLACE FUNCTION create_profile_for_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, name, email)
  VALUES (NEW.id, NEW.name, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_create_profile_on_user_insert
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION create_profile_for_user();

-- =============================================================================
-- ESSAYS
-- =============================================================================

CREATE TABLE essays (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        REFERENCES users(id) ON DELETE CASCADE,
  essay_type          TEXT,
  content             TEXT        NOT NULL,
  overall_score       INT,
  analysis            JSONB,
  degree_level        TEXT,
  university_location TEXT,
  university_id       UUID,
  university_name     TEXT,
  coverage            JSONB,
  language            TEXT,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- TBS SESSIONS
-- =============================================================================

CREATE TABLE tbs_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        REFERENCES users(id) ON DELETE CASCADE,
  category         TEXT,
  total_questions  INT,
  correct          INT,
  percent          INT,
  duration_seconds INT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- INTERVIEW SESSIONS
-- =============================================================================

CREATE TABLE interview_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES users(id) ON DELETE CASCADE,
  essay_excerpt TEXT,
  questions     JSONB,
  answers       JSONB,
  overall_score INT,
  evaluation    JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- PAYMENTS
-- =============================================================================

CREATE TABLE payments (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        REFERENCES users(id) ON DELETE CASCADE,
  order_id               TEXT        UNIQUE NOT NULL,
  plan                   TEXT        NOT NULL,
  amount_idr             INT         NOT NULL,
  currency               TEXT        DEFAULT 'IDR',
  status                 TEXT        NOT NULL DEFAULT 'pending',
  gateway                TEXT        DEFAULT 'midtrans',
  gateway_transaction_id TEXT,
  payment_type           TEXT,
  raw_notification       JSONB,
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- USAGE LOG
-- =============================================================================

CREATE TABLE usage_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT        NOT NULL CHECK (action IN ('essay_check', 'interview_session')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- REFERENCE ESSAYS
-- =============================================================================

CREATE TABLE reference_essays (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        REFERENCES users(id) ON DELETE SET NULL,
  title               TEXT,
  author              TEXT,
  content             TEXT        NOT NULL,
  language            TEXT        DEFAULT 'id' CHECK (language IN ('id', 'en')),
  degree_level        TEXT,
  university_location TEXT,
  university_name     TEXT,
  tags                TEXT[],
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- REFERENCE QUESTIONS
-- =============================================================================

CREATE TABLE reference_questions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  question   TEXT        NOT NULL,
  focus      TEXT,
  language   TEXT        DEFAULT 'id' CHECK (language IN ('id', 'en')),
  notes      TEXT,
  tags       TEXT[],
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- TBS QUESTIONS
-- =============================================================================

CREATE TABLE tbs_questions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category     TEXT        NOT NULL CHECK (category IN ('verbal', 'numerik', 'logika')),
  subcategory  TEXT,
  question     TEXT        NOT NULL,
  options      JSONB       NOT NULL,
  answer_index INT         NOT NULL CHECK (answer_index >= 0),
  explanation  TEXT,
  difficulty   TEXT        DEFAULT 'medium',
  user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- UNIVERSITIES
-- =============================================================================

CREATE TABLE universities (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        UNIQUE,
  short_name TEXT,
  country    TEXT,
  location   TEXT        CHECK (location IN ('indonesia', 'luar_negeri')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- AI PROVIDERS
-- =============================================================================

CREATE TABLE ai_providers (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT           NOT NULL,
provider_type   TEXT        NOT NULL CHECK (provider_type IN ('openai_compatible', 'anthropic', 'cloudflare_ai')),
  api_base_url   TEXT           NOT NULL,
  api_key        TEXT           NOT NULL,
  model          TEXT           NOT NULL,
  is_active      BOOLEAN        DEFAULT true,
  priority       INT            DEFAULT 0,
  max_tokens     INT            DEFAULT 2500,
  temperature    NUMERIC(3, 2)  DEFAULT 0.30,
  extra_headers  JSONB          DEFAULT '{}',
  created_at     TIMESTAMPTZ    DEFAULT now(),
  updated_at     TIMESTAMPTZ    DEFAULT now()
);

CREATE TRIGGER trg_ai_providers_updated_at
BEFORE UPDATE ON ai_providers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_essays_user_created        ON essays             (user_id, created_at DESC);
CREATE INDEX idx_tbs_sessions_user_created  ON tbs_sessions       (user_id, created_at DESC);
CREATE INDEX idx_interview_user_created     ON interview_sessions  (user_id, created_at DESC);
CREATE INDEX idx_payments_user              ON payments            (user_id);
CREATE INDEX idx_payments_status            ON payments            (status);
CREATE INDEX idx_usage_log_user_action      ON usage_log           (user_id, action, created_at);
CREATE INDEX idx_ref_essays_language        ON reference_essays    (language);
CREATE INDEX idx_ref_essays_created         ON reference_essays    (created_at DESC);
CREATE INDEX idx_tbs_questions_category     ON tbs_questions       (category);
CREATE INDEX idx_universities_location      ON universities        (location);
