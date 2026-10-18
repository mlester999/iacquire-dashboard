-- Rollback for 0050_aqi_conversation_content.sql. NOT a migration.
-- Remove only the exact seeded entries; never delete admin-authored replacements.
delete from aqi_knowledge_entries
where source in ('Approved CRM guide', 'Approved team guide')
  and title in ('Adding a CRM contact', 'Inviting a team member');
