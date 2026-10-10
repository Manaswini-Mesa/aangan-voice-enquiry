// Row shapes returned by the repository layer.

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "designer";
  password_hash: string;
  active: boolean;
  is_demo: boolean;
  created_at: string;
  last_login_at: string | null;
}

export type LeadStatus =
  | "new"
  | "in_call"
  | "incomplete"
  | "qualified"
  | "not_qualified"
  | "declined"
  | "review"
  | "complaint"
  | "existing_client"
  | "handed_off"
  | "closed";

export interface LeadRow {
  id: string;
  ref: string;
  channel: string;
  is_simulated: boolean;
  is_demo: boolean;
  enquiry_type: string;
  status: LeadStatus;
  disposition: string | null;
  caller_name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  project_category: string | null;
  property_type: string | null;
  locality: string | null;
  area_sqft: string | number | null;
  scope_summary: string | null;
  timeline_summary: string | null;
  budget_text: string | null;
  authority: string | null;
  review_reasons: Array<{ code: string; message: string; mandatory: boolean }>;
  outside_hours: boolean;
  first_contact_at: string;
  first_response_at: string | null;
  assigned_designer_id: string | null;
  next_action: string | null;
  next_action_due: string | null;
  possible_duplicate_of: string | null;
  summary: string | null;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallRow {
  id: string;
  lead_id: string;
  provider: string;
  provider_call_id: string;
  mode: "live" | "simulated";
  direction: string;
  from_number: string | null;
  status: "active" | "completed" | "disconnected" | "failed";
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: string | number | null;
  end_reason: string | null;
  outside_hours: boolean;
  conversation_state: unknown;
  summary: string | null;
  summary_source: string | null;
  provider_summary: string | null;
  provider_transcript: string | null;
  recording_available: boolean;
  recording_ref: string | null;
  disclosure_given: boolean;
  finalized_at: string | null;
  created_at: string;
}

export interface SegmentRow {
  id: string;
  call_id: string;
  seq: number;
  speaker: "caller" | "agent" | "system";
  text: string;
  confidence: string | number | null;
  turn_key: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  lead_id: string | null;
  kind: string;
  channel: string;
  recipients: string[];
  subject: string;
  body_text: string;
  body_html: string;
  status: "pending" | "sent" | "failed" | "not_configured" | "simulated";
  mode: string;
  attempts: number;
  last_error: string | null;
  idempotency_key: string;
  provider: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  last_attempt_at: string | null;
  created_at: string;
}
