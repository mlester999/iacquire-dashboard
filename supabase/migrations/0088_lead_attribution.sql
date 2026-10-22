-- Phase 3D: lead attribution.
--
--   * lead_touches: an append-only history of where a contact came from, one row per touch (a form, a website chat, a call, a person's manual choice).
--     It records only what the touch carried, and says HOW the source was established: known (explicit campaign tags, a paid click id, a person's choice),
--     inferred (from a referring site or the channel) or unknown. A later touch never rewrites an earlier one.
--   * contacts.first_touch_id / latest_touch_id: pointers into that history. The first is set once and never moved.
--   * attribution_costs: campaign spend a person entered by hand. Nothing here is fetched from an advertising platform, and nothing is guessed:
--     cost per lead and return on spend exist only where a cost was entered.
--
-- Additive. No existing row changes. Workspace-keyed with a composite foreign key, row-level security, and SELECT only for the application role.

create table lead_touches (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  occurred_at timestamptz not null default now(),
  -- Where the touch happened.
  kind text not null check (kind in ('website_form', 'crm_form', 'website_chat', 'call', 'booking', 'manual', 'import', 'api')),
  -- What the touch said about its origin, as it arrived (lower case, trimmed). 'unknown' when it said nothing: never "direct".
  source text not null check (char_length(source) between 1 and 80),
  medium text check (char_length(medium) <= 80),
  campaign text check (char_length(campaign) <= 120),
  content text check (char_length(content) <= 120),
  term text check (char_length(term) <= 120),
  click_ids jsonb not null default '{}'::jsonb check (jsonb_typeof(click_ids) = 'object' and pg_column_size(click_ids) <= 512),
  landing_path text check (char_length(landing_path) <= 300),
  referrer text check (char_length(referrer) <= 300),
  -- known: explicit tags, a paid click id or a person's choice. inferred: from the referring site or the channel. unknown: nothing was recorded.
  confidence text not null check (confidence in ('known', 'inferred', 'unknown')),
  evidence text not null check (evidence in ('utm', 'click_id', 'referrer', 'channel', 'manual', 'none')),
  -- The record this touch came from, so a redelivered event records it once.
  ref_type text check (ref_type in ('form_submission', 'website_submission', 'web_chat_session', 'call', 'booking', 'manual')),
  ref_id text check (char_length(ref_id) <= 80),
  created_by uuid references users(id) on delete set null,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  unique (org_id, ref_type, ref_id)
);
create index lead_touches_contact_idx on lead_touches (org_id, contact_id, occurred_at, id);
create index lead_touches_report_idx on lead_touches (org_id, occurred_at, source);

alter table contacts
  add column first_touch_id bigint,
  add column latest_touch_id bigint;

-- Campaign spend entered by a person. One row per amount for a source (and optionally a campaign) over a period.
create table attribution_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  source text not null check (char_length(source) between 1 and 80),
  campaign text check (char_length(campaign) <= 120),
  period_start date not null,
  period_end date not null,
  amount numeric(14, 2) not null check (amount >= 0 and amount < 100000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  note text check (char_length(note) <= 300),
  entered_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (period_end >= period_start and period_end - period_start <= 366)
);
create index attribution_costs_idx on attribution_costs (org_id, source, period_start);

alter table lead_touches enable row level security;
alter table attribution_costs enable row level security;

revoke all on lead_touches, attribution_costs from public, anon, authenticated;
grant select on lead_touches, attribution_costs to iaq_app_user;

create policy lead_touches_select on lead_touches for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('contacts.view'::text))::uuid[]));
create policy attribution_costs_select on attribution_costs for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('analytics.view'::text))::uuid[]));
