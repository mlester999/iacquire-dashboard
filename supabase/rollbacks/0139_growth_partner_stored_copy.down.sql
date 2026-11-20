-- Roll back only rows that still contain the exact 0139 copy. Customized rows remain intact.
set local lock_timeout = '5s';

update service_catalog
set core_overlap_note = $$Your iAcquire package already includes the AI Appointment Setter for standard follow-up. This service is for separately scoped sequences beyond your agreed package.$$
where slug = 'ai-follow-up-appointment-reminders'
  and core_overlap_note = $$Your AI Growth Partner handles the standard appointment follow-up included in your agreed package. This service covers separately scoped sequences beyond that scope.$$;

update service_catalog
set core_overlap_note = $$Your iAcquire package already includes the AI CRM Manager for standard CRM upkeep. This service is for separately scoped integrations beyond your agreed package.$$
where slug = 'crm-pipeline-automation'
  and core_overlap_note = $$Your AI Growth Partner handles the standard CRM upkeep included in your agreed package. This service covers separately scoped integrations beyond that scope.$$;

update service_catalog
set core_overlap_note = $$Your iAcquire portal already includes analytics and the AI Performance Analyst. This service is for separately scoped reporting pipelines beyond your agreed package.$$
where slug = 'reporting-notification-system'
  and core_overlap_note = $$Your iAcquire portal includes standard analytics, with support from your AI Growth Partner. This service is for separately scoped reporting pipelines beyond your agreed package.$$;

update service_catalog
set core_overlap_note = $$Your iAcquire package already includes standard AI employees such as the AI Appointment Setter. Activating or configuring those is part of your core package and is never an add-on. This service is for separately scoped agents beyond it.$$
where slug = 'ai-inquiry-appointment-agent'
  and core_overlap_note = $$Your AI Growth Partner includes the standard inquiry and appointment workflows agreed for your workspace. Activating or configuring that scope is part of the core package and is never an add-on. This service is for separately scoped agents beyond that scope.$$;

update service_catalog
set core_overlap_note = $$Your iAcquire package already includes standard AI employees such as the AI Appointment Setter. Activating or configuring those is part of your core package and is never an add-on. This service is for separately scoped voice agents beyond it.$$
where slug = 'ai-voice-receptionist'
  and core_overlap_note = $$Your AI Growth Partner includes the standard inquiry and appointment workflows agreed for your workspace. Activating or configuring that scope is part of the core package and is never an add-on. This service is for separately scoped voice agents beyond that scope.$$;

update service_catalog
set core_overlap_note = $$Your iAcquire package includes the iAcquire Assistant and standard AI employees. This service is for a separately scoped support assistant trained on your own documents.$$
where slug = 'customer-support-ai-assistant'
  and core_overlap_note = $$Your iAcquire package includes the AI Growth Partner and its agreed knowledge scope. This service is for a separately scoped support assistant trained on your own documents.$$;

update service_catalog
set accomplishes = array[
      $$Have iAcquire monitor and look after your live system$$,
      $$Get reasonable configuration changes without a new project$$,
      $$Keep your AI employees tuned as your business changes$$
    ]::text[],
    deliverables = array[
      $$Monitoring of your connected integrations and AI employee health, with alerts to our team$$,
      $$Troubleshooting when an integration, workflow or AI employee stops working as configured$$,
      $$Reasonable configuration adjustments, such as updating AI knowledge or instructions, changing approval rules or reconnecting a service$$,
      $$AI optimization reviews based on how your AI employees are performing$$,
      $$Smaller improvements within your monthly request allowance$$
    ]::text[]
where slug = 'managed-maintenance'
  and accomplishes = array[
      $$Monitoring of your connected integrations and AI Growth Partner health, with alerts to our team$$,
      $$Troubleshooting when an integration, workflow or AI Growth Partner stops working as configured$$,
      $$Reasonable configuration adjustments as your business changes, and AI optimization$$
    ]::text[]
  and deliverables = array[
      $$Monitoring of your connected integrations and AI Growth Partner health, with alerts to our team$$,
      $$Troubleshooting when an integration, workflow or AI Growth Partner stops working as configured$$,
      $$Reasonable configuration adjustments as your business changes, and AI optimization$$
    ]::text[];

with copy(new_title, new_category, new_body, new_route, new_source,
          old_title, old_category, old_body, old_route, old_source) as (
  values
    (
      $$What iAcquireOS is$$, $$Platform overview$$,
      $$iAcquireOS is the operating system for an iAcquire client workspace: it brings the AI Growth Partner, leads, appointments, sales, CRM, websites, analytics, knowledge and support into one portal. The exact modules available depend on the workspace and the signed-in person's role.$$,
      null::text, $$Approved platform overview (AI Growth Partner copy 0139)$$,
      $$What iAcquireOS is$$, $$Platform overview$$,
      $$iAcquireOS is the operating system for an iAcquire client workspace: it brings AI employees, leads, appointments, sales, CRM, websites, analytics, knowledge and support into one portal. The exact modules available depend on the workspace and the signed-in person's role.$$,
      null::text, $$Approved platform overview$$
    ),
    (
      $$Knowledge Center$$, $$Knowledge$$,
      $$Knowledge Center holds the company knowledge used by the AI Growth Partner and the documents your team uploads. Owners and managers can edit knowledge. Text notes and selectable-text PDF/Word documents can be read; encrypted or image-only PDFs and damaged files are stored but not used, and OCR is not supported.$$,
      $$/knowledge$$, $$Approved knowledge guide (AI Growth Partner copy 0139)$$,
      $$Knowledge Center$$, $$Knowledge$$,
      $$Knowledge Center holds the company knowledge used by AI employees and the documents your team uploads. Owners and managers can edit knowledge. Text notes and selectable-text PDF/Word documents can be read; encrypted or image-only PDFs and damaged files are stored but not used, and OCR is not supported.$$,
      $$/knowledge$$, $$Approved knowledge guide$$
    ),
    (
      $$Integrations$$, $$Integrations$$,
      $$Integrations connect iAcquireOS to services such as GoHighLevel, calendars, messaging and email. Open Settings → Integrations to see what is connected and what needs attention. Credentials are stored securely and are never shown again. Only an owner or manager can change them.$$,
      $$/settings/integrations$$, $$Approved integrations guide (AI Growth Partner copy 0139)$$,
      $$Integrations$$, $$Integrations$$,
      $$Integrations connect iAcquireOS to services such as Hermes, GoHighLevel, calendars, messaging and email. Open Settings → Integrations to see what is connected and what needs attention. Credentials are stored server-side and are never shown again. Only an owner or manager can change them.$$,
      $$/settings/integrations$$, $$Approved integrations guide$$
    ),
    (
      $$AQi is not an administrator$$, $$Platform overview$$,
      $$AQi can explain the portal and prepare a support request, but it cannot change settings, invite people, publish a website, send messages, move money or change AI Growth Partner configuration for you. Those actions stay with the authorized person and the normal confirmation screens.$$,
      null::text, $$Immutable AQi boundary (AI Growth Partner copy 0139)$$,
      $$AQi is not an administrator$$, $$Platform overview$$,
      $$AQi can explain the portal and prepare a support request, but it cannot change settings, invite people, publish a website, send messages, move money or alter an AI employee for you. Those actions stay with the authorized person and the normal confirmation screens.$$,
      null::text, $$Immutable AQi boundary$$
    )
)
update aqi_knowledge_entries entry
set title = copy.old_title,
    category = copy.old_category,
    body = copy.old_body,
    route_prefix = copy.old_route,
    source = copy.old_source,
    version = 1
from copy
where entry.title = copy.new_title
  and entry.category = copy.new_category
  and entry.body = copy.new_body
  and entry.route_prefix is not distinct from copy.new_route
  and entry.roles = '{}'::text[]
  and entry.status = 'published'
  and entry.source = copy.new_source
  and entry.version = 2
  and not exists (
    select 1 from aqi_knowledge_entries other
    where lower(other.title) = lower(copy.old_title) and other.id <> entry.id
  );

-- Restore the prior seeded entries only when their archived records are still unchanged.
update aqi_knowledge_entries
set status = 'published',
    route_prefix = $$/workforce$$,
    body = $$AI employees are named, role-specific assistants. A workspace owner or manager can open AI Workforce to see each employee, chat with it, review its instructions and activity, and manage its knowledge. Availability depends on the employee's connection and health status; a setup-required or paused employee cannot chat.$$,
    version = 1
where title = $$AI employees$$ and category = $$AI Employees$$
  and body = $$AI Growth Partner is the workspace's configured partner for approved work. Use AI Growth Partner to review status, saved setup, Business Brain and the shared conversation.$$
  and route_prefix = $$/growth-partner$$ and roles = '{}'::text[] and status = 'archived'
  and source = $$Approved workforce guide$$ and version = 2;

update aqi_knowledge_entries
set status = 'published',
    route_prefix = $$/workforce$$,
    body = $$Open an AI employee, then use Configure to edit its tone, instructions and allowed tools. Use the Knowledge tab for employee-specific notes and documents, or the workspace Knowledge Center for company-wide knowledge. Changes are versioned; a risky instruction may be held for iAcquire review. Nothing is applied until the saved version is active.$$,
    version = 1
where title = $$Employee instructions and knowledge$$ and category = $$AI Employees$$
  and body = $$Review the saved AI Growth Partner setup and Business Brain. The page shows current review state; configuration changes follow workspace permission and approval controls.$$
  and route_prefix = $$/growth-partner$$ and roles = '{}'::text[] and status = 'archived'
  and source = $$Approved workforce guide$$ and version = 2;

update aqi_knowledge_entries
set status = 'published',
    route_prefix = $$/chat$$,
    body = $$Open AI Workforce, choose an employee, and select Start a chat. Chat history is saved in the workspace. You can start a new conversation, search earlier conversations, stop a response, or retry after a failure. If the employee is not online, the portal shows its real status instead of pretending it is available.$$,
    version = 1
where title = $$Chat with an AI employee$$ and category = $$AI Employees$$
  and body = $$Open AI Growth Partner, then select Permanent Conversation to use its shared conversation history. The page reports runtime connection separately from whether a conversation exists.$$
  and route_prefix = $$/growth-partner/conversation$$ and roles = '{}'::text[] and status = 'archived'
  and source = $$Approved workforce guide$$ and version = 2;

delete from aqi_knowledge_entries entry
where entry.id = 'e1390000-0000-4139-8139-000000000001'::uuid
  and entry.title = $$AI Growth Partner$$
  and entry.category = $$AI Growth Partner$$
  and entry.body = $$AI Growth Partner is the configured partner for the approved work in this workspace. Review its saved setup, Business Brain, availability and connection status on this page. Use Permanent Conversation to chat with your AI Growth Partner and review the shared conversation history. Its work follows workspace permissions and configured approval rules; a saved setup does not by itself prove that a runtime is online.$$
  and entry.route_prefix = $$/growth-partner$$
  and entry.roles = '{}'::text[] and entry.status = 'published'
  and entry.source = $$Approved AI Growth Partner guide 0139$$ and entry.version = 1
  and entry.review_note = $$Reviewed for the AI Growth Partner stored-copy migration; recheck within 180 days.$$
  and entry.source_kind = 'manual' and entry.freshness_days = 180
  and entry.source_document_id is null
  and not exists (select 1 from aqi_knowledge_documents d where d.knowledge_entry_id = entry.id);

delete from aqi_knowledge_entries entry
where entry.id = 'e1390000-0000-4139-8139-000000000002'::uuid
  and entry.title = $$Business Brain$$
  and entry.category = $$AI Growth Partner$$
  and entry.body = $$Business Brain is the versioned company knowledge used to ground the AI Growth Partner's work. Review each fact's source and status on AI Growth Partner. Confirmed, proposed and superseded facts remain distinguishable, and access to edit or review follows the signed-in person's permissions.$$
  and entry.route_prefix = $$/growth-partner$$
  and entry.roles = '{}'::text[] and entry.status = 'published'
  and entry.source = $$Approved AI Growth Partner knowledge guide 0139$$ and entry.version = 1
  and entry.review_note = $$Reviewed for the AI Growth Partner stored-copy migration; recheck within 180 days.$$
  and entry.source_kind = 'manual' and entry.freshness_days = 180
  and entry.source_document_id is null
  and not exists (select 1 from aqi_knowledge_documents d where d.knowledge_entry_id = entry.id);

delete from aqi_knowledge_entries entry
where entry.id = 'e1390000-0000-4139-8139-000000000003'::uuid
  and entry.title = $$AI Work Board$$
  and entry.category = $$AI Growth Partner$$
  and entry.body = $$The AI Work Board shows recorded work, its current stage, progress and outcomes. It reflects saved work records; an empty or unavailable source is not a completed result. Open a work item to review its recorded details and status.$$
  and entry.route_prefix = $$/work$$
  and entry.roles = '{}'::text[] and entry.status = 'published'
  and entry.source = $$Approved AI Growth Partner work guide 0139$$ and entry.version = 1
  and entry.review_note = $$Reviewed for the AI Growth Partner stored-copy migration; recheck within 180 days.$$
  and entry.source_kind = 'manual' and entry.freshness_days = 180
  and entry.source_document_id is null
  and not exists (select 1 from aqi_knowledge_documents d where d.knowledge_entry_id = entry.id);

delete from aqi_knowledge_entries entry
where entry.id = 'e1390000-0000-4139-8139-000000000004'::uuid
  and entry.title = $$Approvals$$
  and entry.category = $$Approvals$$
  and entry.body = $$Approvals lists actions that are waiting for a person's decision under the workspace's configured approval rules. Review the details before approving or declining. The queue and recorded decision are the source of truth; AQi does not approve actions for you.$$
  and entry.route_prefix = $$/approvals$$
  and entry.roles = '{}'::text[] and entry.status = 'published'
  and entry.source = $$Approved approval guide 0139$$ and entry.version = 1
  and entry.review_note = $$Reviewed for the AI Growth Partner stored-copy migration; recheck within 180 days.$$
  and entry.source_kind = 'manual' and entry.freshness_days = 180
  and entry.source_document_id is null
  and not exists (select 1 from aqi_knowledge_documents d where d.knowledge_entry_id = entry.id);

update aqi_suggested_questions question
set question = $$How do I manage my AI employees?$$
where question.question = $$How do I use my AI Growth Partner?$$
  and question.scope = 'global' and question.role is null and question.route_prefix is null
  and question.sort_order = 20 and question.enabled
  and not exists (
    select 1 from aqi_suggested_questions other
    where other.question = $$How do I manage my AI employees?$$
      and other.scope = question.scope and other.role is not distinct from question.role
      and other.route_prefix is not distinct from question.route_prefix and other.id <> question.id
  );

update aqi_suggested_questions question
set question = $$How do I change an employee's instructions?$$,
    route_prefix = $$/employees$$
where question.question = $$How do I review my AI Growth Partner setup?$$
  and question.scope = 'page' and question.role is null and question.route_prefix = $$/growth-partner$$
  and question.sort_order = 50 and question.enabled
  and not exists (
    select 1 from aqi_suggested_questions other
    where other.question = $$How do I change an employee's instructions?$$
      and other.scope = question.scope and other.role is not distinct from question.role
      and other.route_prefix = $$/employees$$ and other.id <> question.id
  );

delete from aqi_suggested_questions
where (id = 'a1390000-0000-4139-8139-000000000001'::uuid and question = $$What is the Business Brain?$$ and scope = 'page' and role is null and route_prefix = $$/growth-partner$$ and sort_order = 55 and enabled)
   or (id = 'a1390000-0000-4139-8139-000000000002'::uuid and question = $$Where can I review work from my AI Growth Partner?$$ and scope = 'page' and role is null and route_prefix = $$/work$$ and sort_order = 56 and enabled)
   or (id = 'a1390000-0000-4139-8139-000000000003'::uuid and question = $$Where do I review actions waiting for me?$$ and scope = 'page' and role is null and route_prefix = $$/approvals$$ and sort_order = 57 and enabled);

update aqi_contextual_tips
set route_prefix = $$/employees$$,
    title = $$Meet your AI employees$$,
    body = $$AQi can show you where each employee lives and what its status means.$$,
    tutorial_slug = $$view-ai-employees$$
where slug = $$workforce-help$$
  and route_prefix = $$/growth-partner$$
  and title = $$Review your AI Growth Partner$$
  and body = $$Review the saved setup, Business Brain and reported availability. AQi can explain what you see, but changes follow the page's normal controls and approvals.$$
  and roles = '{}'::text[]
  and permission = 'agents.use'
  and tutorial_slug is null
  and enabled
  and priority = 40;
