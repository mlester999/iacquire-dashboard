// SAMPLE DATA for the dev-only design preview. None of this is a real client, task or result.
import {
  CHECK_LABEL,
  computeProgress,
  estimateCompletion,
  evaluateReadiness,
  isApplicable,
  type AgencyCheckView,
  type AgencyEventView,
  type AgencySetupSnapshot,
  type AgencyTaskView,
  type CheckKey,
  type CheckStatus,
  type ClientSetupSnapshot,
  type ClientTaskView,
  type RuleTask,
  type TaskStatus,
} from "@/lib/setup";

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Def {
  n: number;
  key: string;
  title: string;
  client?: string;
  desc: string;
  section: "agency" | "client";
  mode: "manual" | "verified" | "activation";
  check?: CheckKey;
  status: TaskStatus;
  deps?: number[];
  completedMins?: number;
  note?: string;
  clientNote?: string;
  blocked?: string;
  est?: string;
  action?: { type: "approve" | "review_and_approve" | "provide_info" | "external"; label: string; instructions: string };
  requiresResponse?: boolean;
  responded?: { decision: string | null; mins: number };
  source?: "agency" | "connector" | "attestation";
  assignee?: string;
  optional?: boolean;
  hidden?: boolean;
  excluded?: boolean;
}

const DEFS: Def[] = [
  { n: 1, key: "company_info", title: "Company information submitted", desc: "The details you shared about your business, goals and how your AI team should communicate.", section: "client", mode: "verified", check: "onboarding", status: "completed", completedMins: 4300, source: "connector" },
  { n: 2, key: "ghl_subaccount", title: "GHL sub-account created", client: "Your CRM workspace is created", desc: "We create a private CRM workspace for your business so your contacts, pipeline and appointments stay separate from every other client.", section: "agency", mode: "verified", check: "ghl_location", status: "completed", deps: [1], completedMins: 2900, source: "connector", assignee: "u1" },
  { n: 3, key: "crm_snapshot", title: "CRM snapshot installed", client: "CRM template installed", desc: "We install our proven CRM template: pipeline stages, forms and message templates built for client acquisition.", section: "agency", mode: "verified", check: "crm_snapshot", status: "completed", deps: [2], completedMins: 2600, source: "attestation", assignee: "u1" },
  { n: 4, key: "crm_assets", title: "Pipelines, tags, custom fields, and forms configured", client: "Pipelines, tags, fields and forms configured", desc: "We tailor stages, tags and fields to how your business sells, and set up your lead and booking forms.", section: "agency", mode: "verified", check: "crm_assets", status: "in_progress", deps: [3], clientNote: "We are tailoring your pipeline stages to how you sell.", est: "2026-10-21", assignee: "u2" },
  { n: 5, key: "ai_employees", title: "Six client-specific Hermes AI employees configured", client: "Your six AI employees are configured", desc: "Each AI employee gets its own private environment and is checked live before it is marked ready.", section: "agency", mode: "verified", check: "hermes_employees", status: "waiting_for_client", deps: [1], action: { type: "approve", label: "Approve your AI employee configuration", instructions: "Review how each AI employee will work and communicate in AI Employees, then approve so we can finish and test them." }, requiresResponse: true, clientNote: "Take a look at each employee's summary, then approve when it feels right.", assignee: "u1" },
  { n: 6, key: "workflows", title: "Automation workflows configured", client: "Automations configured", desc: "Follow-up and reminder workflows are built, tested and reviewed by our team. Nothing is switched on without your approval.", section: "agency", mode: "verified", check: "workflows", status: "pending", deps: [4] },
  { n: 7, key: "website_built", title: "Website and funnel built", desc: "Our team designs and builds your website and lead-capture funnel.", section: "agency", mode: "manual", status: "completed", deps: [1], completedMins: 95, note: "Your new website has been built and is ready for review.", source: "agency", assignee: "u2" },
  { n: 8, key: "website_published", title: "Website published and domain connected", desc: "After you approve the design, we publish your website and connect your domain.", section: "agency", mode: "verified", check: "website_live", status: "waiting_for_client", deps: [7], action: { type: "review_and_approve", label: "Review your website", instructions: "Open the preview link and approve the design, or tell us what you would like changed." }, requiresResponse: true, clientNote: "Your preview is ready. Please review it when you have a few minutes." },
  { n: 9, key: "email_domain", title: "Business email configured and verified", client: "Business email set up and verified", desc: "We set up your business email address and verify your domain so your messages are trusted and delivered.", section: "client", mode: "verified", check: "email_domain", status: "blocked", deps: [1], blocked: "We are waiting for access to your domain provider so we can add the DNS records. Please add the DNS records we share, or grant your assigned team member access through your provider. Never send passwords in a message.", action: { type: "external", label: "Verify your email domain", instructions: "We will share the DNS records to add at your domain provider. Tell us when they are in place so we can verify them." } },
  { n: 10, key: "calendar", title: "Google Calendar connected and appointment availability checked", client: "Google Calendar connected", desc: "We connect your calendar so your AI Appointment Setter only offers times that are really free.", section: "client", mode: "verified", check: "calendar", status: "ready_for_review", deps: [2], action: { type: "external", label: "Connect Google Calendar", instructions: "Approve access to the Google calendar we should use, then let us know it is done." }, responded: { decision: "confirm", mins: 40 } },
  { n: 11, key: "integration_tests", title: "AI workforce and integration tests passed", client: "Final system checks passed", desc: "We run live checks across your AI employees and connected tools before activation.", section: "agency", mode: "verified", check: "final_health", status: "pending", deps: [2, 4, 5, 6, 8, 9, 10] },
  { n: 12, key: "final_review", title: "Final agency review and activation", client: "Final review and activation", desc: "Our team does a last quality review and then approves your system for activation.", section: "agency", mode: "activation", status: "pending", deps: [11] },
  { n: 13, key: "custom_brand", title: "Brand approval", desc: "Approve your logo and brand colors for the website and emails.", section: "client", mode: "manual", status: "pending", optional: true, est: "2026-10-24" },
  { n: 14, key: "legacy_import", title: "Import old customer list", desc: "Optional one-time import of your existing customers.", section: "agency", mode: "manual", status: "pending", optional: true, hidden: true },
];

const rule = (d: Def): RuleTask & { estimatedCompletionAt: string | null } => ({
  id: id(d.n),
  title: d.client ?? d.title,
  status: d.status,
  required: !d.optional,
  hidden: Boolean(d.hidden),
  serviceExcluded: Boolean(d.excluded),
  completionMode: d.mode,
  checkKey: d.check ?? null,
  dependsOn: (d.deps ?? []).map(id),
  estimatedCompletionAt: d.est ?? null,
});

export function clientFixture(opts: { checkIssue?: boolean } = {}): ClientSetupSnapshot {
  const rules = DEFS.map(rule);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const visible = rules.filter(isApplicable);
  const tasks: ClientTaskView[] = DEFS.filter((d) => !d.hidden && !d.excluded).map((d) => {
    const waiting = (d.deps ?? []).map((n) => byId.get(id(n))!).filter((x) => x.status !== "completed" && isApplicable(x));
    const open = d.status === "waiting_for_client" && Boolean(d.action);
    return {
      id: id(d.n),
      title: d.client ?? d.title,
      description: d.desc,
      section: d.section === "client" || open ? "client" : "agency",
      status: d.status,
      isActivation: d.mode === "activation",
      required: !d.optional,
      completedAt: d.completedMins ? ago(d.completedMins) : null,
      completionNote: d.note ?? null,
      clientNote: d.clientNote ?? null,
      blockedReason: d.blocked ?? null,
      estimatedCompletionAt: d.status === "completed" ? null : (d.est ?? null),
      updatedAt: ago(d.completedMins ?? 25 + d.n * 7),
      waitingOn: waiting.map((w) => w.title),
      action: d.action ? { ...d.action, available: open && !waiting.length, unavailableReason: null, previewLinks: d.action.type === "review_and_approve" ? [{ label: "Open website preview", url: "https://example.com/preview" }] : [] } : null,
      responded: d.responded ? { at: ago(d.responded.mins), decision: d.responded.decision } : null,
      attachments: d.action?.type === "review_and_approve" ? [{ id: "a1", label: "Website preview", url: "https://example.com/preview", kind: "website_preview" }] : [],
      history: d.status === "completed" ? [{ at: ago(d.completedMins ?? 60), text: `Completed${d.note ? ` — ${d.note}` : ""}` }] : [],
    };
  });
  const progress = computeProgress(visible);
  return {
    revision: 12,
    generatedAt: ago(0),
    orgName: "Bright Homes Realty",
    state: "in_setup",
    activatedAt: null,
    progress,
    estimatedCompletion: estimateCompletion(visible),
    lastUpdatedAt: ago(25),
    finalCheckIssue: Boolean(opts.checkIssue),
    canRespond: true,
    needsAttention: tasks.filter((t) => t.action?.available).length,
    tasks,
  };
}

const CHECKS: Array<[CheckKey, CheckStatus, string | null]> = [
  ["onboarding", "verified", "Onboarding submitted 2026-10-11."],
  ["ghl_location", "verified", "Read access verified (3 pipelines)."],
  ["crm_snapshot", "attested", "Confirmed by the agency; not machine-verified."],
  ["crm_assets", "unverified", "Tags, custom fields and forms are not read from GoHighLevel yet (only pipelines are synced)."],
  ["hermes_employees", "failed", "1 of 6 AI employees failing: Appointment Setter (offline)."],
  ["workflows", "unverified", "Workflow health in n8n and GoHighLevel is not read per client yet. The portal never activates workflows."],
  ["website_live", "unverified", "Website publishing and domain connection are not verified automatically yet."],
  ["email_domain", "unverified", "Email domain (DNS/SPF/DKIM) verification is not connected yet."],
  ["calendar", "unverified", "Google authorization and live availability are not verified by the portal yet."],
  ["final_health", "unverified", "Still to verify: CRM pipelines, tags, fields and forms; Automation workflows."],
];
const IMPLEMENTED = new Set<CheckKey>(["onboarding", "ghl_location", "hermes_employees", "final_health"]);

export function agencyFixture(): AgencySetupSnapshot {
  const rules = DEFS.map(rule);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const checkMap = Object.fromEntries(CHECKS.map(([k, s]) => [k, s])) as Partial<Record<CheckKey, CheckStatus>>;
  const tasks: AgencyTaskView[] = DEFS.map((d, i) => ({
    id: id(d.n),
    templateKey: d.n <= 12 ? d.key : null,
    title: d.title,
    clientTitle: d.client ?? null,
    description: d.desc,
    section: d.section,
    completionMode: d.mode,
    checkKey: d.check ?? null,
    service: null,
    status: d.status,
    required: !d.optional,
    hidden: Boolean(d.hidden),
    serviceExcluded: Boolean(d.excluded),
    requiresEvidence: false,
    requiresClientResponse: Boolean(d.requiresResponse),
    sortOrder: (i + 1) * 10,
    assignedTo: d.assignee ?? null,
    estimatedCompletionAt: d.est ?? null,
    clientNote: d.clientNote ?? null,
    blockedReason: d.blocked ?? null,
    completionNote: d.note ?? null,
    clientAction: d.action ?? null,
    clientResponse: d.responded ? { decision: d.responded.decision, at: ago(d.responded.mins), message: null } : null,
    clientRespondedAt: d.responded ? ago(d.responded.mins) : null,
    completedAt: d.completedMins ? ago(d.completedMins) : null,
    completedBy: d.completedMins ? (d.source === "connector" ? null : "Avery Admin") : null,
    completionSource: d.completedMins ? (d.source ?? "agency") : null,
    verifiedAt: d.source === "connector" || d.source === "attestation" ? ago(d.completedMins ?? 0) : null,
    verifiedDetail: d.source === "connector" ? "Read access verified (3 pipelines)." : d.source === "attestation" ? "Confirmed by the agency; not machine-verified." : null,
    updatedAt: ago(d.completedMins ?? 25 + d.n * 7),
    dependsOn: (d.deps ?? []).map(id),
    unmetDependencies: (d.deps ?? []).map(id).filter((x) => byId.get(x)!.status !== "completed" && isApplicable(byId.get(x)!)),
    attachments: d.action?.type === "review_and_approve" ? [{ id: "a1", label: "Website preview", url: "https://example.com/preview", kind: "website_preview", visibility: "client", createdAt: ago(100) }] : [],
  }));
  const applicableChecks = new Set(DEFS.filter((d) => d.check && !d.hidden).map((d) => d.check!));
  const checks: AgencyCheckView[] = CHECKS.filter(([k]) => applicableChecks.has(k)).map(([key, status, detail]) => ({
    key,
    label: CHECK_LABEL[key],
    status,
    detail,
    source: status === "verified" || status === "failed" ? "connector" : status === "attested" ? "attestation" : null,
    checkedAt: status === "unverified" ? null : ago(18),
    attestedBy: status === "attested" ? "Avery Admin" : null,
    evidenceUrl: null,
    note: null,
    connectorImplemented: IMPLEMENTED.has(key),
    connectorNote: IMPLEMENTED.has(key) ? null : detail,
    appliesTo: DEFS.filter((d) => d.check === key).map((d) => d.title),
  }));
  const ev = (n: number, over: Partial<AgencyEventView>): AgencyEventView => ({ id: String(n), taskId: null, at: ago(n * 9), actor: "Avery Admin", actorKind: "agency", event: "status_changed", fromStatus: null, toStatus: null, body: null, reason: null, visibility: "internal", ...over });
  const events: AgencyEventView[] = [
    ev(1, { taskId: id(7), fromStatus: "in_progress", toStatus: "completed", body: "Your new website has been built and is ready for review.", visibility: "client" }),
    ev(2, { taskId: id(10), event: "client_responded", actor: "Jordan Owner", actorKind: "client", fromStatus: "waiting_for_client", toStatus: "ready_for_review", body: "You confirmed it is done.", visibility: "client" }),
    ev(3, { taskId: id(9), fromStatus: "in_progress", toStatus: "blocked", body: "We are waiting for access to your domain provider.", reason: "Client has not replied in 3 days. Chase on Monday.", visibility: "client" }),
    ev(4, { taskId: id(4), event: "note", reason: "Using the real-estate pipeline variant. Check stage names with the owner.", visibility: "internal" }),
    ev(5, { taskId: id(3), event: "attested", reason: "Snapshot installed and the pipeline matches the template; checked inside GoHighLevel.", visibility: "internal" }),
    ev(6, { event: "check_run", actor: null, actorKind: "system" }),
  ];
  const readiness = evaluateReadiness({ state: "in_setup", tasks: rules, checks: checkMap });
  return {
    revision: 12,
    generatedAt: ago(0),
    org: { id: id(900), name: "Bright Homes Realty", status: "active", onboardingCompletedAt: ago(4300), timezone: "America/New_York" },
    state: "in_setup",
    services: ["crm", "ai_workforce", "automations", "website", "email", "calendar"],
    responsibleUserId: "u1",
    readyForReviewAt: null,
    activatedAt: null,
    progress: computeProgress(rules),
    estimatedCompletion: estimateCompletion(rules.filter(isApplicable)),
    readiness,
    tasks,
    events,
    checks,
    staff: [
      { id: "u1", name: "Avery Admin", role: "agency_super_admin" },
      { id: "u2", name: "Sam Staff", role: "agency_staff" },
    ],
    canActivate: false,
  };
}
