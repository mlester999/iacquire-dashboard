# Blockers and approvals

| Item | Blocks | Needs | What is done instead |
| --- | --- | --- | --- |
| Hosted migrations 0087 and 0088 | Anything on production that uses website chat or attribution | Founder approval, per migration set (backup, dry run, one at a time). Both rehearse clean on embedded Postgres | Local rehearsal only. Nothing applied |
| Push, merge to master, deploy | Release of Phase 3 | Founder approval | Local commits on `feat/phases-3-7` only |
| Scheduler job `webChatRetention` | Automatic deletion of old chats | Founder approval to start the scheduler stage that includes it | Tested with the clock injected; has never run live |
| Hermes (employee runtime) not provisioned in production | Real AI replies from the website chat | Founder-approved Hermes activation | The chat has an honest fallback (collects contact details, asks a person to follow up); tests use a simulated reply generator and say so |
| No live language model evaluated | Quality claims for chat replies, price grounding, instruction-leak blocking | A provider key and an evaluation | Stub and simulated generators only; labelled |
| Verified revenue and ROI | Return-on-spend figures on the Lead Sources report | Phase 5 verified payments | The report shows deal value labelled as such and says "Needs verified payments"; no ROI number is ever produced from deal value |
| Meta app review and permissions | Live Facebook / Instagram publishing (Phase 4) | A Meta app, business verification, permission approval | Local parts only, no live publish |
| Google Drive and OneDrive connections | Client-owned media storage (Phase 4D) | OAuth apps for both providers | Entitlement-aware local storage rules only |
| E-signature provider account | Signature status from a real provider (Phase 5B) | A provider account and credentials | Provider adapter interface and honest "not connected" state |
| Client payment provider connections | Verified client payments (Phase 5D) | Per-client provider authorization | Webhook handling with signed fixtures; no real payment |
| Demo funnel absent from this tree | Phase 7D verification | Locating the implementation (another branch) or a decision to build | Reported as absent |
| Sidebar link names (pre-existing) | A clean axe run on every portal page | A small fix in the shared shell: the AI-employee links' `aria-label` should start with their visible text | Not part of Phase 3; recorded so it is not mistaken for a Phase 3 regression |
| Legal and consent wording for the chat | Enabling the chat for real visitors | Founder or counsel review of the privacy notice default and the consent text recorded with a lead | The default notice says the chat is answered by an AI assistant and may be reviewed; consent is recorded with the exact wording shown; marketing consent only with a ticked box |
