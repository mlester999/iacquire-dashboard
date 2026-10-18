-- 0050_aqi_conversation_content.sql
-- Data-only knowledge additions for conversational answers that previously had no grounded source.
-- This migration is local/prepared only until an authorized hosted release.

insert into aqi_knowledge_entries (title, category, body, route_prefix, roles, status, source, published_at)
values
  (
    'Adding a CRM contact',
    'CRM',
    'Open CRM and go to Contacts, then choose New contact. Enter at least a first name; add a last name, email, phone, lead status, owner, lead source, company and tags as needed. An email or phone that already belongs to another contact is never duplicated; use Find that contact instead. Select Add contact to save. This requires CRM contact edit permission. AQi can explain the steps but cannot create the contact for you.',
    '/crm',
    '{}',
    'published',
    'Approved CRM guide',
    now()
  ),
  (
    'Inviting a team member',
    'Account and permissions',
    'Open Settings and go to Team. Under Invite a teammate, enter the person''s email address, choose their role, and select Invite. The person receives an email to set up their account, and the invitation expires after 7 days. Owners and managers with team permission can invite; pending invitations can be revoked from the same page. AQi cannot send the invitation for you.',
    '/settings/team',
    '{}',
    'published',
    'Approved team guide',
    now()
  )
on conflict do nothing;
