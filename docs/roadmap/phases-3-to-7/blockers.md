# Blockers and approvals

| Item | Blocks | Needs | What is done instead |
| --- | --- | --- | --- |
| Hermes (employee runtime) not provisioned in production | Real AI replies from the website chat | Founder-approved Hermes activation | The chat has an honest fallback (collects contact details, asks a person to follow up); tests use a simulated reply generator and say so |
| No live language model evaluated | Quality claims for chat and lead extraction | A provider key and an evaluation | Simulated generators only; labelled |
| Meta app review and permissions | Live Facebook / Instagram publishing (Phase 4) | A Meta app, business verification, permission approval | Local parts only, no live publish |
| Google Drive and OneDrive connections | Client-owned media storage (Phase 4D) | OAuth apps for both providers | Entitlement-aware local storage rules only |
| E-signature provider account | Signature status from a real provider (Phase 5B) | A provider account and credentials | Provider adapter interface and honest "not connected" state |
| Client payment provider connections | Verified client payments (Phase 5D) | Per-client provider authorization | Webhook handling with signed fixtures; no real payment |
| Hosted migrations, push, deploy, scheduler | Release of anything in this initiative | Founder approval, per migration set | Local rehearsal only |
| Demo funnel absent from this tree | Phase 7D verification | Locating the implementation (another branch) or a decision to build | Reported as absent |
