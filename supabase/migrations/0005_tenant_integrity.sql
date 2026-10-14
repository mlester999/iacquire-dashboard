-- Same-tenant composite foreign keys.
--
-- Foreign-key checks bypass row-level security, so a plain FK would let a row in tenant A
-- reference a parent row in tenant B. Composite (id, org_id) keys make that impossible.

alter table agent_instances add constraint agent_instances_id_org_key unique (id, org_id);
alter table agent_config_versions add constraint agent_config_versions_id_org_key unique (id, org_id);
alter table chat_conversations add constraint chat_conversations_id_org_key unique (id, org_id);
alter table agent_runs add constraint agent_runs_id_org_key unique (id, org_id);
alter table approval_requests add constraint approval_requests_id_org_key unique (id, org_id);
alter table lead_research_requests add constraint lead_research_requests_id_org_key unique (id, org_id);
alter table retention_accounts add constraint retention_accounts_id_org_key unique (id, org_id);
alter table support_tickets add constraint support_tickets_id_org_key unique (id, org_id);

alter table agent_config_versions
  add constraint agent_config_versions_agent_same_org
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade;

alter table agent_provisioning_jobs
  add constraint provisioning_jobs_agent_same_org
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade;

alter table chat_conversations
  add constraint chat_conversations_agent_same_org
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade;

alter table chat_messages
  add constraint chat_messages_conversation_same_org
  foreign key (conversation_id, org_id) references chat_conversations (id, org_id) on delete cascade;

alter table agent_runs
  add constraint agent_runs_agent_same_org
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade;

alter table agent_runs
  add constraint agent_runs_conversation_same_org
  foreign key (conversation_id, org_id) references chat_conversations (id, org_id);

alter table tool_executions
  add constraint tool_executions_run_same_org
  foreign key (run_id, org_id) references agent_runs (id, org_id) on delete cascade;

alter table approval_requests
  add constraint approval_requests_agent_same_org
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id);

alter table approval_events
  add constraint approval_events_approval_same_org
  foreign key (approval_id, org_id) references approval_requests (id, org_id) on delete cascade;

alter table leads
  add constraint leads_research_same_org
  foreign key (research_request_id, org_id) references lead_research_requests (id, org_id);

alter table customer_feedback
  add constraint customer_feedback_account_same_org
  foreign key (account_id, org_id) references retention_accounts (id, org_id) on delete cascade;

alter table service_history
  add constraint service_history_account_same_org
  foreign key (account_id, org_id) references retention_accounts (id, org_id) on delete cascade;

alter table support_messages
  add constraint support_messages_ticket_same_org
  foreign key (ticket_id, org_id) references support_tickets (id, org_id) on delete cascade;

alter table usage_events
  add constraint usage_events_agent_same_org
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id);
