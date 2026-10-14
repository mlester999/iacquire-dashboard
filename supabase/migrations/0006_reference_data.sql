-- Reference data: the six default AI employee roles and the role/permission matrix.
-- This is product configuration, not customer data. src/lib/permissions.ts mirrors this matrix
-- and tests/permissions.test.ts fails if the two drift apart.

insert into agent_roles (key, name, short_name, tagline, description, capabilities, default_tools, accent, sort_order) values
('operations_manager', 'AI Operations Manager', 'Operations Manager',
 'Keeps your AI team coordinated and on track.',
 'Coordinates the team, tracks business operations, manages tasks, identifies blockers and prepares summaries.',
 '["Daily and weekly operating summaries", "Task tracking and prioritisation", "Blocker and risk identification", "Team coordination across employees"]',
 '["tasks.read", "approvals.create", "summaries.write"]', '#7C8BA6', 1),
('lead_hunter', 'AI Lead Hunter', 'Lead Hunter',
 'Finds and evaluates businesses that fit your ideal customer.',
 'Researches and evaluates potential customers, checks qualification criteria, identifies buying signals and prepares lead recommendations.',
 '["Research from approved public sources", "Evidence-backed lead scoring", "Qualification against your rules", "Lead recommendations for your review"]',
 '["research.public_web", "leads.stage_for_review"]', '#5CCB2E', 2),
('appointment_setter', 'AI Appointment Setter', 'Appointment Setter',
 'Turns qualified interest into booked meetings.',
 'Helps with qualification, available appointment slots, booking requests, confirmations, cancellation and rescheduling.',
 '["Reads real calendar availability", "Prepares booking requests", "Confirmation, cancellation and rescheduling support", "Appointment status lookups"]',
 '["calendar.read_availability", "appointments.read", "appointments.request_change"]', '#FF9500', 3),
('sales_assistant', 'AI Sales Assistant', 'Sales Assistant',
 'Prepares follow-ups, proposals and discovery calls.',
 'Helps with sales conversations, prospect follow-ups, discovery call preparation, proposal drafts and opportunity management.',
 '["Follow-up drafts for your approval", "Discovery call preparation", "Proposal outlines", "Opportunity reviews"]',
 '["crm.read_opportunities", "drafts.create"]', '#FF2E93', 4),
('crm_manager', 'AI CRM Manager', 'CRM Manager',
 'Keeps your customer records clean and organised.',
 'Helps organize customer information, update permitted CRM records, maintain pipelines and identify duplicate records.',
 '["Pipeline hygiene reviews", "Duplicate record detection", "Proposed CRM updates for approval", "Customer information summaries"]',
 '["crm.read", "crm.request_update"]', '#0A84FF', 5),
('performance_analyst', 'AI Performance Analyst', 'Performance Analyst',
 'Explains what is working and what to improve.',
 'Analyzes leads, appointments, conversion performance, operational results and areas for improvement.',
 '["Funnel and conversion analysis", "Lead source performance", "Workforce activity reports", "Improvement recommendations"]',
 '["analytics.read"]', '#12C9A5', 6);

insert into role_permissions (role, permission)
select r.role, p.permission
from (values
  -- permission,               owner, admin, member, staff, super
  ('workspace.view',            true,  true,  true,   true,  true),
  ('workspace.manage_profile',  true,  true,  false,  true,  true),
  ('team.view',                 true,  true,  true,   true,  true),
  ('team.manage',               true,  true,  false,  false, true),
  ('agents.use',                true,  true,  true,   false, false),
  ('agents.configure',          true,  true,  false,  false, false),
  ('knowledge.view',            true,  true,  true,   true,  true),
  ('knowledge.edit',            true,  true,  false,  true,  true),
  ('leads.view',                true,  true,  true,   true,  true),
  ('leads.research',            true,  true,  false,  false, false),
  ('leads.review',              true,  true,  false,  false, false),
  ('leads.export',              true,  true,  false,  false, false),
  ('appointments.view',         true,  true,  true,   true,  true),
  ('sales.view',                true,  true,  true,   true,  true),
  ('notes.write',               true,  true,  true,   false, false),
  ('tasks.manage',              true,  true,  true,   false, false),
  ('retention.view',            true,  true,  true,   true,  true),
  ('retention.edit',            true,  true,  false,  false, false),
  ('analytics.view',            true,  true,  true,   true,  true),
  ('analytics.export',          true,  true,  false,  false, false),
  ('approvals.view',            true,  true,  true,   true,  true),
  ('approvals.decide',          true,  true,  false,  false, false),
  ('approvals.decide_high',     true,  false, false,  false, false),
  ('activity.view',             true,  true,  false,  true,  true),
  ('integrations.view',         true,  true,  false,  true,  true),
  ('usage.view',                true,  true,  false,  true,  true),
  ('billing.view',              true,  false, false,  true,  true),
  ('support.use',               true,  true,  true,   false, false)
) as p(permission, owner, admin, member, staff, super_admin)
cross join lateral (values
  ('owner', p.owner), ('admin', p.admin), ('member', p.member),
  ('agency_staff', p.staff), ('agency_super_admin', p.super_admin)
) as r(role, allowed)
where r.allowed;
