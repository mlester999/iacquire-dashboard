# iAcquireOS product terminology audit

The current product centers on one **AI Growth Partner**, one permanent conversation and one versioned Business Brain. Lead discovery and qualification, CRM, appointments, schedules, approvals, the AI Work Board and reporting are capabilities and workspace tools.

The audit inventoried App Router pages and checked active page and component copy, SEO metadata, empty and loading states, tooltips, accessible names, runtime messages, prompts that can inform visible replies, notification builders and email templates. Browser observations use the disposable CRM QA fixture. The source audit includes routes and states beyond the browser sample.

| Surface | Result and compatibility notes |
| --- | --- |
| Login | Current Growth Partner showcase and one sign-in form. Auth providers and account paths retain their existing access rules. Login browser evidence is recorded separately. |
| Product landing and SEO | /product describes one Growth Partner and labels its acquisition workflow as a sample. Root page-title metadata uses iAcquireOS. The root redirect and indexing behavior retain their existing rules. |
| Signup, account verification and invitations | Get Started and account screens lead to the existing demo, verification or invitation workflows. Registration, workspace assignment and invitation URLs retain their existing rules. |
| Password recovery | Request and reset screens use account-security copy. Recovery labels do not present AI identities. |
| Welcome and company onboarding | Welcome explains the shared Business Brain and shows a capability list. The questionnaire and its review keep business context, goals and working style under one Growth Partner. |
| Setup Center and provisioning | The owner reviews Business Brain facts and follows connection checks. Persisted legacy checklist titles and actions are normalized at presentation time, including completion notifications. Stored template keys remain compatible. |
| Client overview | The Partner readiness card and workspace priorities appear before the charts. Leads awaiting review, enabled schedules, failed jobs and reported integration errors come from tenant records, subject to the viewer's permissions. Previous profile warnings carry a historical label. |
| Navigation and accessibility labels | The sidebar and search expose the current Growth Partner, Control Center and AI Work Board. Previous role profiles appear only with legacy records and the required permissions. Narrow breadcrumbs wrap across two lines. |
| Growth Partner Control Center | The header links to the available next step and Business Brain, exposes readiness and shows Work Board activity before workspace links. Capabilities are actions of the same identity. The AQi Business Brain target points to the section it describes. |
| Permanent conversation and legacy links | Client chat entry points open the workspace's Growth Partner conversation or setup state. Historical conversation records and agency-only internal threads retain their attribution. |
| Leads and qualification | Discovery, qualification and the approval queue use Growth Partner language and source evidence. The acquisition workstream records provider and native CRM acceptance separately. |
| Native CRM | CRM settings and AI actions use Growth Partner or neutral AI profile labels. Saved workflow and record attribution can still refer to a previous profile. |
| Appointments and schedule views | Booking approval reasons use the AI conversation and AI appointment wording. Historical activity, audit actors, appointment ownership and staff roles remain distinguishable. |
| AI Work Board | The current Partner is the default identity shown for supported actions without an enabled previous profile. Historical runtime and schedule attribution remains visible when an actual record exists. |
| Automation Studio and CRM workflows | The builder uses the workspace's authorized runtime list and prefers the Growth Partner for new AI steps. Existing saved profile assignments remain available for workflow editing and execution. |
| Goals and AI preferences | Goals, tone and behavior are workspace-level controls for one Partner. Human teammates and agency approval roles are separate concepts. |
| Business Brain | Facts, drafts, active versions and sources use the unified Business Brain vocabulary. Persisted section keys such as employeeGoals and employeeBehavior remain compatible. |
| Memory and Knowledge Center | Memory and approved company references are shown under one Growth Partner. Previous profile knowledge retains its source and review state. |
| Integrations | Workspace settings identify connections by service. Notion and Airtable knowledge sources have review and provenance controls. Live provider validation is tracked separately. |
| Analytics, CRM reports and exports | Analytics presents current Partner work and grouped previous-profile activity. CRM reports use AI activity for acquisition sources and AI profile for individual tool attribution. |
| Notifications and email templates | Reviewed setup, runtime, booking and account mail paths. New runtime and customer-facing refusal copy uses Growth Partner or neutral profile terminology. Previously stored notifications and audit entries remain part of history. |
| Requests and support | Customer support and change requests use Growth Partner terminology. Optional project categories use custom AI workflows. Existing category keys and request history remain readable. |
| AQi Assistant and help | Public guidance describes capabilities of one Growth Partner. Historical search terms remain accepted as aliases for routing and help retrieval. |
| Super Admin | AI Growth Partner Operations leads with the current fleet, Business Brain state, failed work and migration review. Previous client profile activity and internal agency tools open from explicitly labeled sections. |
| Internal admin, managers and staff | Internal agency profiles and their controls stay available to authorized operators. These tools are agency operations, and legacy client work is labeled as retained. |
| Demo and public previews | The request page shows one sample workflow with evidence, duplicate checking and review cues. The guided walkthrough presents one Partner and labels synthetic acquisition, CRM and work history. |
| Pricing, packages and FAQ | The landing and demo present one Growth Partner and cover approved setup and optional maintenance prices. Extra-work descriptions use custom AI workflows. |
| Empty, unavailable and loading states | Reviewed app-level and route-level states for setup, chat, work, integrations and operation errors. Current UI distinguishes setup required, connection unavailable, approval required and prior activity. |
| Historical portfolio and exports | Past case-study classifications and previously saved chat, job, export and profile history can retain their original wording and attribution. Current offboarding export descriptions use neutral configuration and history labels. |

Runtime source still contains the previous AI terms in compatibility translations, help aliases and internal searches, old profile compilation paths, migration and rollback SQL, historical test fixtures and versioned customer records. Route paths such as /employees, role keys, storage columns, template identifiers, permissions, assignments and audit event types retain their meaning.

Browser viewport captures and the automated results are in `.data/release-qa/product-viewport/` in the candidate worktree. The matrix covers product landing, guided-demo landing fixture, client overview, welcome, onboarding, Control Center, conversation setup, AI Work Board, integrations, the Super Admin fleet and the workspace operations detail. It exercises recorded readiness states from a synthetic workspace and does not establish live model or OAuth acceptance.
