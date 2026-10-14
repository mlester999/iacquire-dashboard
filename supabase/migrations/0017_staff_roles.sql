-- Client staff roles, role permissions for inbox/escalations, and per-person staff profiles.
-- Client roles: owner (Business Owner), admin (Manager), member (earlier general role), sales_rep,
-- support, viewer. Agency roles stay a separate access model and never appear as a client role.

alter table organization_memberships drop constraint organization_memberships_role_check;
alter table organization_memberships add constraint organization_memberships_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer'));
alter table invitations drop constraint invitations_role_check;
alter table invitations add constraint invitations_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer'));
alter table role_permissions drop constraint role_permissions_role_check;
alter table role_permissions add constraint role_permissions_role_check
  check (role in ('owner', 'admin', 'member', 'sales_rep', 'support', 'viewer', 'agency_staff', 'agency_super_admin'));

-- Generated from src/lib/permissions.ts. tests/workforce-config.test.ts fails if the two differ.
insert into role_permissions (role, permission) values
  ('sales_rep', 'workspace.view'),
  ('support', 'workspace.view'),
  ('viewer', 'workspace.view'),
  ('sales_rep', 'team.view'),
  ('support', 'team.view'),
  ('viewer', 'team.view'),
  ('sales_rep', 'agents.use'),
  ('support', 'agents.use'),
  ('sales_rep', 'knowledge.view'),
  ('support', 'knowledge.view'),
  ('viewer', 'knowledge.view'),
  ('sales_rep', 'leads.view'),
  ('support', 'leads.view'),
  ('viewer', 'leads.view'),
  ('sales_rep', 'appointments.view'),
  ('support', 'appointments.view'),
  ('viewer', 'appointments.view'),
  ('sales_rep', 'sales.view'),
  ('support', 'sales.view'),
  ('viewer', 'sales.view'),
  ('sales_rep', 'notes.write'),
  ('support', 'notes.write'),
  ('sales_rep', 'tasks.manage'),
  ('support', 'tasks.manage'),
  ('sales_rep', 'retention.view'),
  ('support', 'retention.view'),
  ('viewer', 'retention.view'),
  ('sales_rep', 'analytics.view'),
  ('support', 'analytics.view'),
  ('viewer', 'analytics.view'),
  ('sales_rep', 'approvals.view'),
  ('support', 'approvals.view'),
  ('viewer', 'approvals.view'),
  ('sales_rep', 'support.use'),
  ('support', 'support.use'),
  ('sales_rep', 'setup.view'),
  ('support', 'setup.view'),
  ('viewer', 'setup.view'),
  ('sales_rep', 'projects.view'),
  ('support', 'projects.view'),
  ('viewer', 'projects.view'),
  ('owner', 'inbox.view'),
  ('admin', 'inbox.view'),
  ('member', 'inbox.view'),
  ('sales_rep', 'inbox.view'),
  ('support', 'inbox.view'),
  ('viewer', 'inbox.view'),
  ('owner', 'inbox.view_all'),
  ('admin', 'inbox.view_all'),
  ('owner', 'inbox.reply'),
  ('admin', 'inbox.reply'),
  ('member', 'inbox.reply'),
  ('sales_rep', 'inbox.reply'),
  ('support', 'inbox.reply'),
  ('owner', 'inbox.assign'),
  ('admin', 'inbox.assign'),
  ('owner', 'inbox.notes'),
  ('admin', 'inbox.notes'),
  ('member', 'inbox.notes'),
  ('sales_rep', 'inbox.notes'),
  ('support', 'inbox.notes'),
  ('owner', 'inbox.resume_ai'),
  ('admin', 'inbox.resume_ai'),
  ('sales_rep', 'inbox.resume_ai'),
  ('support', 'inbox.resume_ai'),
  ('owner', 'escalations.respond'),
  ('admin', 'escalations.respond'),
  ('sales_rep', 'escalations.respond'),
  ('support', 'escalations.respond'),
  ('owner', 'escalations.configure'),
  ('admin', 'escalations.configure'),
  ('owner', 'contacts.view'),
  ('admin', 'contacts.view'),
  ('member', 'contacts.view'),
  ('sales_rep', 'contacts.view'),
  ('support', 'contacts.view'),
  ('viewer', 'contacts.view'),
  ('owner', 'contacts.edit'),
  ('admin', 'contacts.edit'),
  ('member', 'contacts.edit'),
  ('sales_rep', 'contacts.edit'),
  ('support', 'contacts.edit'),
  ('owner', 'contacts.merge'),
  ('admin', 'contacts.merge'),
  ('owner', 'messaging.configure'),
  ('admin', 'messaging.configure'),
  ('owner', 'consent.manage'),
  ('admin', 'consent.manage'),
  ('owner', 'staff.availability'),
  ('admin', 'staff.availability'),
  ('member', 'staff.availability'),
  ('sales_rep', 'staff.availability'),
  ('support', 'staff.availability')
on conflict do nothing;

-- One row per person per workspace. The alert phone is personal data: it is not granted to the
-- application role at all, and is read and written only by trusted server code for the person themself.
create table staff_profiles (
  org_id uuid not null,
  user_id uuid not null,
  availability text not null default 'available' check (availability in ('available', 'busy', 'away')),
  availability_note text check (char_length(availability_note) <= 200),
  availability_until timestamptz,
  responsibilities text[] not null default '{}'
    check (responsibilities <@ array['sales', 'support', 'scheduling', 'billing', 'general']::text[]),
  escalation_categories text[] not null default '{}'
    check (escalation_categories <@ array['ready_to_close', 'human_requested', 'phone_consultation', 'complaint', 'refund_concern',
      'sensitive_negotiation', 'frustrated_customer', 'unanswered_question', 'unsafe_or_uncertain']::text[]),
  notify_email boolean not null default true,
  notify_sms boolean not null default false,
  notify_whatsapp boolean not null default false,
  alert_phone text check (alert_phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- Optional personal alerts need a phone number and an explicit, recorded acknowledgement of the cost.
  optional_alerts_opt_in_at timestamptz,
  -- Only meaningful for the business owner: how escalations reach them first.
  owner_priority_mode text not null default 'first_priority' check (owner_priority_mode in ('first_priority', 'notify_only', 'urgent_only')),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references organization_memberships (org_id, user_id) on delete cascade,
  check (not (notify_sms or notify_whatsapp) or (alert_phone is not null and optional_alerts_opt_in_at is not null))
);
create trigger staff_profiles_touch before update on staff_profiles for each row execute function app.touch_updated_at();

alter table staff_profiles enable row level security;
revoke all on staff_profiles from public, anon, authenticated;
grant select (org_id, user_id, availability, availability_note, availability_until, responsibilities, escalation_categories,
  notify_email, notify_sms, notify_whatsapp, owner_priority_mode, updated_at) on staff_profiles to iaq_app_user;
create policy staff_profiles_select on staff_profiles for select to iaq_app_user
  using (user_id = app.current_user_id() or app.has_permission(org_id, 'team.view'));
