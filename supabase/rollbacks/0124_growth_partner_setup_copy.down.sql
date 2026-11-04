-- The migration seeds these exact values into default templates. Preserve any edits or
-- additional copy by refusing rollback if data differs from that generated baseline.
do $$
begin
  if exists (
    select 1
      from public.client_setup_template_tasks tt
      join public.client_setup_templates t on t.id = tt.template_id
     where (
       t.is_default
       and tt.key = 'ai_employees'
       and row(
         tt.growth_partner_title,
         tt.growth_partner_client_title,
         tt.growth_partner_description,
         tt.growth_partner_completion_notice,
         tt.growth_partner_client_action
       ) is distinct from row(
         'AI Growth Partner runtime and safety checks passed',
         'Your AI Growth Partner is ready',
         'We prepare one tenant-isolated Growth Partner profile with its approved persona, permissions and Business Brain. It becomes ready only after its connection, identity and permitted-tool checks pass.',
         'Your AI Growth Partner is ready',
         '{"type":"approve","label":"Approve your AI Growth Partner configuration","instructions":"Review your partner’s Business Brain, behavior and permissions in AI Growth Partner, then approve so we can finish and test the setup."}'::jsonb
       )
     )
     or (
       t.is_default
       and tt.key = 'ai_configuration'
       and row(
         tt.growth_partner_title,
         tt.growth_partner_client_title,
         tt.growth_partner_description,
         tt.growth_partner_completion_notice,
         tt.growth_partner_client_action
       ) is distinct from row(
         'AI Growth Partner configuration prepared',
         null::text,
         'We prepare one stable AI Growth Partner around your approved Business Brain, communication preferences and permitted capabilities.',
         null::text,
         null::jsonb
       )
     )
     or (
       t.is_default
       and tt.key = 'ai_profiles'
       and row(
         tt.growth_partner_title,
         tt.growth_partner_client_title,
         tt.growth_partner_description,
         tt.growth_partner_completion_notice,
         tt.growth_partner_client_action
       ) is distinct from row(
         'AI Growth Partner Hermes profile provisioned',
         'Your private AI Growth Partner profile is prepared',
         'We prepare one private Hermes profile for your AI Growth Partner. It becomes ready only after its connection and safety checks pass.',
         null::text,
         null::jsonb
       )
     )
     or (
       t.is_default
       and tt.key = 'integration_tests'
       and row(
         tt.growth_partner_title,
         tt.growth_partner_client_title,
         tt.growth_partner_description,
         tt.growth_partner_completion_notice,
         tt.growth_partner_client_action
       ) is distinct from row(
         'AI Growth Partner and integration checks passed',
         'Final system checks passed',
         'We run live checks across your AI Growth Partner, CRM and connected tools before activation.',
         null::text,
         null::jsonb
       )
     )
     or (
       t.is_default
       and tt.key = 'knowledge_review'
       and row(
         tt.growth_partner_title,
         tt.growth_partner_client_title,
         tt.growth_partner_description,
         tt.growth_partner_completion_notice,
         tt.growth_partner_client_action
       ) is distinct from row(
         null::text,
         null::text,
         'We review the approved Business Brain and company information before the AI Growth Partner is activated.',
         null::text,
         null::jsonb
       )
     )
     or (
       (not t.is_default or tt.key not in ('ai_employees', 'ai_configuration', 'ai_profiles', 'integration_tests', 'knowledge_review'))
       and (
         tt.growth_partner_title is not null
         or tt.growth_partner_client_title is not null
         or tt.growth_partner_description is not null
         or tt.growth_partner_completion_notice is not null
         or tt.growth_partner_client_action is not null
       )
     )
  ) then
    raise exception 'cannot_remove_growth_partner_setup_copy_with_customized_values' using errcode = '55000';
  end if;
end
$$;

alter table client_setup_template_tasks
  drop column growth_partner_title,
  drop column growth_partner_client_title,
  drop column growth_partner_description,
  drop column growth_partner_completion_notice,
  drop column growth_partner_client_action;
