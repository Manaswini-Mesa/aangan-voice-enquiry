-- Aangan Studio enquiry system — initial schema.
-- Runs on PostgreSQL 14+ (Neon) and PGlite (demo mode). Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'designer')),
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rule_versions (
  version TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS lead_ref_seq START 1001;

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref TEXT NOT NULL UNIQUE DEFAULT ('AAN-' || nextval('lead_ref_seq')::text),
  channel TEXT NOT NULL DEFAULT 'phone',
  is_simulated BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  enquiry_type TEXT NOT NULL DEFAULT 'new_enquiry',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','in_call','incomplete','qualified','not_qualified','declined','review','complaint','existing_client','handed_off','closed')),
  disposition TEXT,
  caller_name TEXT,
  phone TEXT,
  phone_normalized TEXT,
  email TEXT,
  project_category TEXT,
  property_type TEXT,
  locality TEXT,
  area_sqft NUMERIC,
  scope_summary TEXT,
  timeline_summary TEXT,
  budget_text TEXT,
  authority TEXT,
  review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  outside_hours BOOLEAN NOT NULL DEFAULT FALSE,
  first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_response_at TIMESTAMPTZ,
  assigned_designer_id UUID REFERENCES users(id),
  next_action TEXT,
  next_action_due TIMESTAMPTZ,
  possible_duplicate_of UUID REFERENCES leads(id),
  summary TEXT,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads (phone_normalized);
CREATE INDEX IF NOT EXISTS leads_assigned_idx ON leads (assigned_designer_id);

CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'simulated')),
  direction TEXT NOT NULL DEFAULT 'inbound',
  from_number TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','disconnected','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_sec NUMERIC,
  end_reason TEXT,
  outside_hours BOOLEAN NOT NULL DEFAULT FALSE,
  conversation_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT,
  summary_source TEXT,
  provider_summary TEXT,
  provider_transcript TEXT,
  recording_available BOOLEAN NOT NULL DEFAULT FALSE,
  recording_ref TEXT,
  disclosure_given BOOLEAN NOT NULL DEFAULT FALSE,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX IF NOT EXISTS calls_lead_idx ON calls (lead_id);
CREATE INDEX IF NOT EXISTS calls_started_idx ON calls (started_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('caller', 'agent', 'system')),
  text TEXT NOT NULL,
  confidence NUMERIC,
  turn_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_turn_key_idx ON transcript_segments (call_id, turn_key) WHERE turn_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  source TEXT NOT NULL,
  confidence NUMERIC NOT NULL,
  validation TEXT NOT NULL DEFAULT 'valid',
  evidence TEXT,
  superseded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facts_lead_idx ON facts (lead_id, key) WHERE NOT superseded;

CREATE TABLE IF NOT EXISTS assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('automated', 'human_override')),
  rule_version TEXT NOT NULL,
  disposition TEXT NOT NULL,
  criteria JSONB NOT NULL,
  review_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  precedence_trace JSONB NOT NULL DEFAULT '[]'::jsonb,
  facts_snapshot JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  rationale TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assessments_lead_idx ON assessments (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_assignment'
    CHECK (status IN ('pending_assignment','assigned','accepted','completed','cancelled')),
  designer_id UUID REFERENCES users(id),
  brief JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed','not_configured','simulated')),
  mode TEXT NOT NULL DEFAULT 'live',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications (status);

CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  due_at TIMESTAMPTZ,
  notes TEXT,
  assigned_to UUID REFERENCES users(id),
  dedupe_key TEXT UNIQUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id),
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS follow_ups_open_idx ON follow_ups (status, due_at);

CREATE TABLE IF NOT EXISTS complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  client_name TEXT,
  designer_name TEXT,
  project_ref TEXT,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  callback_requested BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  preferred_text TEXT,
  preferred_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation','confirmed','rejected','cancelled','reschedule_requested')),
  provider TEXT NOT NULL DEFAULT 'manual',
  confirmation_ref TEXT,
  confirmed_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  cost_amount NUMERIC,
  cost_currency TEXT,
  cost_type TEXT NOT NULL CHECK (cost_type IN ('actual','estimate','unavailable')),
  mode TEXT NOT NULL DEFAULT 'live',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_created_idx ON usage_events (created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  provider_call_id TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ops_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  source TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_events_created_idx ON ops_events (created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_lead_idx ON audit_log (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_checks (
  integration TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
