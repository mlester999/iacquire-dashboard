// The screens, rendered from real service output (a seeded synthetic workspace), not hand-written fixtures: the missed-call recovery tab and its
// settings, the lead priority card and settings, and the Inbox cards. They check what a person is told (and not told), empty and error states,
// that nothing prints undefined / NaN / [object Object], and the accessibility basics a static render can show (names, headings, labels).
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/calls", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/missed-calls", () => Object.fromEntries(["assignMissedCallAction", "pauseMissedCallAction", "resumeMissedCallAction", "closeMissedCallAction", "retryMissedCallAction", "escalateMissedCallAction", "approveRecoveryDraftAction", "rejectRecoveryDraftAction", "saveRecoveryPolicyAction", "activateRecoveryPolicyAction"].map((n) => [n, stub])));
vi.mock("@/app/actions/lead-scoring", () => Object.fromEntries(["setPriorityOverrideAction", "clearPriorityOverrideAction", "reassessLeadAction", "saveScoringProfileAction", "backfillLeadScoresAction"].map((n) => [n, stub])));

import { createContact } from "@/server/crm/contacts";
import { scopeFor } from "@/server/crm/page";
import { assessContact } from "@/server/lead-scoring/service";
import { getPriority, scoringStats, setOverride } from "@/server/lead-scoring/priority";
import { readProfile } from "@/server/lead-scoring/profile";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { getCase, listCases, openCaseFor } from "@/server/missed-calls/ops";
import { readPolicy } from "@/server/missed-calls/policy";
import { recoveryStats } from "@/server/missed-calls/analytics";
import { CaseDetailContent, RecoveryWorkspace } from "@/components/crm/recovery/recovery-workspace";
import { RecoverySettings } from "@/components/crm/recovery/recovery-settings";
import { MissedCallBanner } from "@/components/crm/recovery/missed-call-banner";
import { PriorityBadge, PriorityCard } from "@/components/crm/priority/priority-ui";
import { LeadScoringSettings } from "@/components/crm/priority/lead-scoring-settings";
import { InboxMissedCallCard, InboxPriorityCard } from "@/components/inbox/priority-panel";
import { inbound } from "./support/messaging";
import { callerNumber, minutesAfter, missedCallFrom, recoveryWorkspace, type RecoveryWorkspace as RecoveryFixture } from "./support/missed-calls";

const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const BAD = /undefined|NaN|\[object Object\]|null</;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

let r: RecoveryFixture;
let contactId: string;
let caseId: string;

beforeAll(async () => {
  r = await recoveryWorkspace({ mode: "assisted" });
  const a = await missedCallFrom(r, { name: "Dana Lee" });
  contactId = a.contact.id;
  caseId = a.caseRow.id;
  await processMissedCalls({ now: minutesAfter(5), orgId: r.w.org.id });
  await missedCallFrom(r, { name: "No Consent Nick", consent: false });
  await processMissedCalls({ now: minutesAfter(8), orgId: r.w.org.id });
  for (let i = 0; i < 3; i += 1) {
    await inbound(r.w.org.id, { provider: "twilio", address: a.caller, providerMessageId: `ui_${i}`, body: ["Hi, available this week?", "Can I get a quote?", "Ready to go ahead"][i], receivedAt: new Date(Date.now() - (9 - i) * 60_000) });
  }
  await assessContact(r.w.org.id, contactId);
});

describe("the recovery tab", () => {
  async function props(group: "needs_you" | "all" = "all", selected?: string) {
    const scope = await scopeFor(r.owner, "/crm");
    const [stats, cases, { policy, readiness }] = await Promise.all([recoveryStats(r.owner, 30), listCases(r.owner, { group }), readPolicy(r.owner)]);
    const detail = selected ? json(await getCase(r.owner, selected)) : null;
    return { scope: json(scope), stats: json(stats), cases: json(cases), group, policy: json(policy), readiness: json(readiness), members: [{ id: r.w.people.sales.id, name: "Sam Sales" }], selected: detail, canWork: true, canConfigure: true, hrefFor: (p: { group?: string; case?: string | null; page?: number; tab?: string }) => `/crm/calls?tab=${p.tab ?? "recovery"}${p.group ? `&group=${p.group}` : ""}${p.case ? `&case=${p.case}` : ""}` };
  }

  it("lists missed callers with a plain status, a reason and real numbers", async () => {
    const markup = html(<RecoveryWorkspace {...(await props("all"))} />);
    const t = text(markup);
    expect(t).toContain("Dana Lee");
    expect(t).toMatch(/Follow-up ready|Ready to follow up/);
    expect(t).toMatch(/No consent to text/);
    expect(t).toContain("Last 30 days");
    expect(t).toMatch(/Incoming calls\s*2/);
    expect(t).not.toMatch(BAD);
    // It never prints revenue it cannot see.
    expect(t).not.toMatch(/revenue|\$\d/i);
    // Links and controls have names.
    expect(markup).toMatch(/aria-label="Filter missed calls"/);
    expect(markup).toMatch(/aria-label="Missed calls"/);
  });

  it("words a readiness item that is not met as 'Not yet', never as the good state beside its own problem", async () => {
    // Found in browser QA: the banner printed "The platform's sending switch is on." followed by "...for this provider is off".
    const t = text(html(<RecoveryWorkspace {...(await props("all"))} />));
    expect(t).toMatch(/Not yet: the recovery worker has run recently\. Pending:/);
    expect(t).not.toMatch(/(?<!Not yet: )the recovery worker has run recently\. Pending/i);
  });

  it("opens a case with its draft waiting for approval, its history and the controls a teammate needs", async () => {
    const p = await props("all", caseId);
    const markup = html(<CaseDetailContent scope={p.scope} detail={p.selected!} members={p.members} canWork />);
    const t = text(markup);
    expect(t).toContain("Waiting for approval");
    expect(t).toMatch(/Approve and send/);
    expect(t).toMatch(/Pause automatic follow-up/);
    expect(t).toMatch(/Mark recovered/);
    expect(t).toMatch(/History/);
    expect(t).toMatch(/Missed call detected/);
    expect(t).toMatch(/An AI call-back needs|Call-back task/);
    expect(markup).toMatch(/<textarea[^>]*aria-label="Text to send"/);
    expect(t).not.toMatch(BAD);
  });

  it("says plainly when recovery is off, and shows an honest empty state with no data", async () => {
    const off = await recoveryWorkspace({ mode: "manual", policy: { enabled: false } });
    const scope = await scopeFor(off.owner, "/crm");
    const [stats, cases, { policy, readiness }] = await Promise.all([recoveryStats(off.owner, 30), listCases(off.owner, { group: "all" }), readPolicy(off.owner)]);
    const t = text(html(<RecoveryWorkspace scope={json(scope)} stats={json(stats)} cases={json(cases)} group="all" policy={json(policy)} readiness={json(readiness)} members={[]} selected={null} canWork canConfigure hrefFor={() => "/crm/calls?tab=recovery"} />));
    expect(t).toContain("Recovery is off");
    expect(t).toMatch(/No missed calls yet/);
    expect(t).toMatch(/only ever holds calls your provider reported/);
    expect(t).not.toMatch(BAD);
  });

  it("hides the work controls from people who cannot work cases, and keeps the history readable", async () => {
    const p = await props("all", caseId);
    const t = text(html(<CaseDetailContent scope={p.scope} detail={p.selected!} members={p.members} canWork={false} />));
    expect(t).not.toMatch(/Approve and send|Mark recovered|Pause automatic|Save owner/);
    expect(t).toMatch(/History/);
    expect(t).toContain("Waiting for approval");
  });

  it("shows the banner and cards in a contact page and the Inbox", async () => {
    const scope = json(await scopeFor(r.owner, "/crm"));
    const open = json(await openCaseFor(r.owner, { contactId }));
    expect(open).not.toBeNull();
    const banner = text(html(<MissedCallBanner scope={scope} view={open!} />));
    expect(banner).toMatch(/Missed call/);
    expect(banner).toMatch(/Open/);
    const inbox = text(html(<InboxMissedCallCard view={open!} />));
    expect(inbox).toMatch(/Missed call/);
    expect(inbox).not.toMatch(BAD);
  });
});

describe("recovery settings", () => {
  it("shows a checklist that is honest about what is not ready, and never offers an AI call-back as working", async () => {
    const w = await recoveryWorkspace({ mode: "manual", policy: { enabled: false } });
    const scope = json(await scopeFor(w.owner, "/crm"));
    const { policy, readiness } = await readPolicy(w.owner);
    const markup = html(<RecoverySettings scope={scope} policy={json(policy)} readiness={json(readiness)} members={[]} businessName="Harbor Roofing" canConfigure />);
    const t = text(markup);
    expect(t).toContain("Is it ready?");
    expect(t).toMatch(/Pending: the platform's scheduler has not run/);
    expect(t).toMatch(/Not available yet: it needs an outbound-calling connection that has been verified/);
    expect(t).toMatch(/Team only/);
    expect(t).toMatch(/Draft for approval/);
    expect(t).toMatch(/Send automatically/);
    expect(t).not.toMatch(BAD);
    // Every field has a label.
    for (const id of ["rp-delay", "rp-abandon", "rp-expiry", "rp-owner"]) expect(markup).toContain(`for="${id}"`);
  });

  it("asks a person to confirm before any text can be drafted or sent, and previews the wording with the business name", async () => {
    const w = await recoveryWorkspace({ mode: "automatic", activate: false });
    const scope = json(await scopeFor(w.owner, "/crm"));
    const { policy, readiness } = await readPolicy(w.owner);
    const t = text(html(<RecoverySettings scope={scope} policy={json(policy)} readiness={json(readiness)} members={[]} businessName="Harbor Roofing" canConfigure />));
    expect(t).toMatch(/Not confirmed: no text will be drafted or sent/);
    expect(t).toMatch(/Confirm and activate/);
    expect(t).toMatch(/Preview:.*Harbor Roofing/);
    expect(t).toMatch(/Only people with consent on record/);
  });

  it("is read-only for someone who cannot configure it", async () => {
    const scope = json(await scopeFor(r.viewer, "/crm").catch(() => scopeFor(r.owner, "/crm")));
    const { policy, readiness } = await readPolicy(r.owner);
    const markup = html(<RecoverySettings scope={scope} policy={json(policy)} readiness={json(readiness)} members={[]} businessName="Harbor" canConfigure={false} />);
    expect(text(markup)).toMatch(/Only a workspace owner or manager can change these settings/);
    expect(markup).not.toMatch(/Save settings/);
  });
});

describe("lead priority screens", () => {
  it("explains a score: what it rests on, why, what is missing and the next step", async () => {
    const scope = json(await scopeFor(r.owner, "/crm"));
    const view = json(await getPriority(r.owner, contactId));
    const markup = html(<PriorityCard scope={scope} contactId={contactId} view={view} canEdit />);
    const t = text(markup);
    expect(t).toContain("Lead priority");
    expect(t).toMatch(/What it is based on/);
    expect(t).toMatch(/Why/);
    expect(t).toMatch(/Suggested next step/);
    expect(t).toMatch(/The language model never sets a score/);
    expect(t).toMatch(/Set the priority yourself/);
    expect(t).not.toMatch(BAD);
    expect(markup).toMatch(/aria-label="Check this lead again"/);
  });

  it("shows 'Insufficient data' as something different from Cold, and 'Not scored' before the first look", async () => {
    const empty = await createContact(r.owner, { displayName: "Blank Bo", phone: callerNumber() });
    await assessContact(r.w.org.id, empty.id);
    const scope = json(await scopeFor(r.owner, "/crm"));
    const t = text(html(<PriorityCard scope={scope} contactId={empty.id} view={json(await getPriority(r.owner, empty.id))} canEdit />));
    expect(t).toMatch(/Insufficient data/);
    expect(t).toMatch(/not the same as cold/i);
    expect(t).not.toMatch(/Cold/);
    expect(text(html(<PriorityBadge label={null} />))).toContain("Not scored");
  });

  it("shows a teammate's override beside what the rules say, and offers to return to automatic", async () => {
    const c = await createContact(r.owner, { displayName: "Override Ola", phone: callerNumber() });
    await assessContact(r.w.org.id, c.id);
    await setOverride(r.owner, c.id, { label: "cold", reason: "Said they are only gathering prices" });
    const scope = json(await scopeFor(r.owner, "/crm"));
    const t = text(html(<PriorityCard scope={scope} contactId={c.id} view={json(await getPriority(r.owner, c.id))} canEdit />));
    expect(t).toMatch(/set this to Cold/);
    expect(t).toMatch(/Said they are only gathering prices/);
    expect(t).toMatch(/never replace a teammate/);
    expect(t).toMatch(/Return to automatic/);
  });

  it("hides editing from people who cannot edit contacts", async () => {
    const scope = json(await scopeFor(r.owner, "/crm"));
    const t = text(html(<PriorityCard scope={scope} contactId={contactId} view={json(await getPriority(r.owner, contactId))} canEdit={false} />));
    expect(t).not.toMatch(/Set the priority yourself/);
  });

  it("the Inbox card is short, and never shows message text", async () => {
    const view = json(await getPriority(r.owner, contactId));
    const markup = html(<InboxPriorityCard view={view} contactHref={`/crm/contacts/${contactId}`} />);
    const t = text(markup);
    expect(t).toContain("Lead priority");
    expect(t).not.toMatch(/Can I get a quote|Ready to go ahead|available this week/);
    expect(t).not.toMatch(BAD);
  });

  it("the scoring settings list every criterion with its points, keep protected fields out, and say the model is optional", async () => {
    const scope = json(await scopeFor(r.owner, "/crm"));
    const [{ profile, criteria, fields }, stats] = await Promise.all([readProfile(r.owner), scoringStats(r.owner)]);
    const markup = html(<LeadScoringSettings scope={scope} profile={json(profile)} criteria={json(criteria)} fields={fields} stats={json(stats)} canConfigure />);
    const t = text(markup);
    expect(t).toContain("Lead scoring");
    expect(t).toMatch(/Nothing about who a person is can be used/);
    expect(t).toMatch(/Reached out themselves/);
    expect(t).toMatch(/Cannot be contacted/);
    expect(t).toMatch(/Counts against/);
    expect(t).toMatch(/Reading their messages \(optional\)/);
    expect(t).toMatch(/Off by default/);
    expect(t).toMatch(/Signals needed to score/);
    expect(t).toMatch(/never Cold/);
    expect(t).not.toMatch(BAD);
    expect(markup).toContain('for="ls-hot"');
  });
});
