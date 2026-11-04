-- 0122: give the one Growth Partner runtime a reviewed internal capability policy.
-- This adds reference data only. It does not create tenant runtime rows, Hermes profiles,
-- schedules, credentials, or alter the six preserved legacy identities.

insert into agent_roles (key, name, short_name, tagline, description, capabilities, default_tools, accent, sort_order)
values (
  'growth_partner',
  'AI Growth Partner',
  'AI Growth Partner',
  'One coordinated partner for customer acquisition and business growth.',
  'One tenant-isolated employee identity with six internal capability domains, each still limited by the signed-in person, workspace policy, the partner’s Allowed actions, connected tools and required approvals.',
  '["Lead Discovery & Qualification", "Sales & Outreach", "Calendar & Appointment Management", "CRM & Pipeline Management", "Business Operations", "Performance & Analytics"]'::jsonb,
  '["tasks.read", "research.public_web", "leads.stage_for_review", "calendar.read_availability", "appointments.read", "appointments.request_change", "calendar.booking_rules.update", "calendar.create", "crm.read", "crm.read_opportunities", "crm.contacts.create", "drafts.create", "analytics.read"]'::jsonb,
  '#8067F5',
  7
);
