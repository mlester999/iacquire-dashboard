-- Store Growth Partner-specific setup copy alongside the six-role template copy.
-- Existing template fields and already-created tenant task snapshots remain unchanged.
alter table client_setup_template_tasks
  add column growth_partner_title text,
  add column growth_partner_client_title text,
  add column growth_partner_description text,
  add column growth_partner_completion_notice text,
  add column growth_partner_client_action jsonb;

update client_setup_template_tasks tt
   set growth_partner_title = case tt.key
         when 'ai_employees' then 'AI Growth Partner runtime and safety checks passed'
         when 'ai_configuration' then 'AI Growth Partner configuration prepared'
         when 'ai_profiles' then 'AI Growth Partner Hermes profile provisioned'
         when 'integration_tests' then 'AI Growth Partner and integration checks passed'
         else null
       end,
       growth_partner_client_title = case tt.key
         when 'ai_employees' then 'Your AI Growth Partner is ready'
         when 'ai_profiles' then 'Your private AI Growth Partner profile is prepared'
         when 'integration_tests' then 'Final system checks passed'
         else null
       end,
       growth_partner_description = case tt.key
         when 'ai_employees' then 'We prepare one tenant-isolated Growth Partner profile with its approved persona, permissions and Business Brain. It becomes ready only after its connection, identity and permitted-tool checks pass.'
         when 'ai_configuration' then 'We prepare one stable AI Growth Partner around your approved Business Brain, communication preferences and permitted capabilities.'
         when 'ai_profiles' then 'We prepare one private Hermes profile for your AI Growth Partner. It becomes ready only after its connection and safety checks pass.'
         when 'integration_tests' then 'We run live checks across your AI Growth Partner, CRM and connected tools before activation.'
         when 'knowledge_review' then 'We review the approved Business Brain and company information before the AI Growth Partner is activated.'
         else null
       end,
       growth_partner_completion_notice = case when tt.key = 'ai_employees' then 'Your AI Growth Partner is ready' else null end,
       growth_partner_client_action = case when tt.key = 'ai_employees'
         then '{"type":"approve","label":"Approve your AI Growth Partner configuration","instructions":"Review your partner’s Business Brain, behavior and permissions in AI Growth Partner, then approve so we can finish and test the setup."}'::jsonb
         else null
       end
  from client_setup_templates t
 where tt.template_id = t.id
   and t.is_default
   and tt.key in ('ai_employees', 'ai_configuration', 'ai_profiles', 'integration_tests', 'knowledge_review');
