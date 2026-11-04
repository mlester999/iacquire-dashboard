# Harvey pattern review

Reviewed 2026-11-04 against [`ethanplusai/harvey` commit `6b6a23a`](https://github.com/ethanplusai/harvey/commit/6b6a23a789090e165802baef4104ee4618a3e169). This is a design review; no Harvey source code or runtime was copied into iAcquireOS.

## Patterns worth adapting

- **A measured work loop:** Harvey checks urgent replies and safety gates before choosing campaign or prospecting work. Its scheduler makes deterministic choices from persisted work counts, bounds cycle duration and backs off after repeated failures. iAcquireOS should keep this priority in the existing job runner so incoming customer work is not starved by research.
- **Evidence-first qualification:** prospect signals have a stable name, plain-language meaning, collection cost and confidence floor. A person confirms which signals matter before collection. Each finding is an observation with provenance, not a guessed property on a company row; repeated observations can show change over time.
- **Separate discovery and profiling:** each stage can retry independently. Profiling queries persisted leads that are missing a fresh observation, so a partial run resumes without re-buying discovery. Enrichment is limited to likely-fit prospects.
- **Bounded public-site research:** the public profile collector uses small, explicit fetches and freshness windows. It labels missing information as missing and does not treat it as negative evidence.
- **Playbooks selected by context:** skills such as lead qualification, prospecting tactics and objection handling are focused references loaded for the task. They inform writing without granting tools or permissions.
- **Approval outbox:** proposed outbound messages are stored separately from delivered messages. A human can inspect and approve a draft; replies are handled before another send, and an opt-out or response stops follow-up.
- **Visible operating limits:** provider spend, per-cycle work, sending windows, quiet hours, deliverability and error backoff are explicit. A degraded or unavailable check is shown as unknown rather than treated as a pass.

## How this maps to iAcquireOS

Use the existing tenant-scoped lead research, CRM, campaign, review/approval, messaging, Work Board and scheduler services. Add source evidence and observed-at facts to those records where they are currently absent. Keep discovery and profiling as independently retryable jobs, with idempotency and tenant/user/action/tool permission checks at execution time. Drafts remain drafts until an authorized approval path completes.

Harvey's own workflow, authentication, local Python runtime, dashboard and branding do not fit this application and are excluded. The repository is MIT-licensed. Since this review adapts design ideas only, no license notice is required in product code; if source code is later reused, include the MIT copyright and license text with that code.

## Source files reviewed

- [README](https://github.com/ethanplusai/harvey/blob/main/README.md) — pipeline, signal catalog, skills, outbox, safety and usage controls.
- [`harvey/main.py`](https://github.com/ethanplusai/harvey/blob/main/harvey/main.py) — deterministic heartbeat, reply-first ordering, cycle timeout and failure backoff.
- [`harvey/pipeline.py`](https://github.com/ethanplusai/harvey/blob/main/harvey/pipeline.py) — independently retryable discovery and profiling stages and stale-profile refresh.
- [`harvey/signals.py`](https://github.com/ethanplusai/harvey/blob/main/harvey/signals.py) — user-confirmed signal catalog, costs, confidence and observation model.
- [`skills/`](https://github.com/ethanplusai/harvey/tree/main/skills) — contextual sales playbooks.
- [MIT license](https://github.com/ethanplusai/harvey/blob/main/LICENSE).
