"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, BookOpen, CheckCircle2, FlaskConical, History, KeyRound, LifeBuoy, Plus, RotateCcw, Save, Settings2, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import {
  archiveAqiKnowledgeAction,
  deleteAqiQuestionAction,
  previewAqiRetrievalAction,
  publishAqiConfigAction,
  saveAqiBudgetAction,
  saveAqiConfigAction,
  saveAqiModelPriceAction,
  saveAqiKnowledgeAction,
  saveAqiQuestionAction,
  testAqiProviderAction,
} from "@/app/actions/aqi";
import type { AqiAdminData, AqiConfig } from "@/server/aqi/service";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

type Tab = "overview" | "provider" | "instructions" | "conversation" | "knowledge" | "questions" | "testing" | "history" | "usage" | "budgets" | "attachments";

const TABS: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
  { key: "overview", label: "Overview", icon: <Sparkles className="size-3.5" /> },
  { key: "provider", label: "Provider & model", icon: <KeyRound className="size-3.5" /> },
  { key: "instructions", label: "Instructions", icon: <Settings2 className="size-3.5" /> },
  { key: "conversation", label: "Conversation behavior", icon: <Sparkles className="size-3.5" /> },
  { key: "knowledge", label: "Platform knowledge", icon: <BookOpen className="size-3.5" /> },
  { key: "questions", label: "Suggested questions", icon: <Plus className="size-3.5" /> },
  { key: "testing", label: "Testing & publishing", icon: <FlaskConical className="size-3.5" /> },
  { key: "history", label: "Version history", icon: <History className="size-3.5" /> },
  { key: "usage", label: "Usage & health", icon: <CheckCircle2 className="size-3.5" /> },
  { key: "budgets", label: "Budgets & pricing", icon: <KeyRound className="size-3.5" /> },
  { key: "attachments", label: "Messaging & attachments", icon: <LifeBuoy className="size-3.5" /> },
];

export function AqiAdmin({ data }: { data: AqiAdminData }) {
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("overview");
  const [config, setConfig] = React.useState<AqiConfig>(data.published.config);
  const [draftId, setDraftId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testPrompt, setTestPrompt] = React.useState("Where do I manage my AI employees?");
  const [testResult, setTestResult] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [knowledge, setKnowledge] = React.useState<(typeof data.knowledge)[number] | null>(data.knowledge[0] ?? null);
  const [knowledgeDraft, setKnowledgeDraft] = React.useState({ title: "", category: "Platform overview", routePrefix: "", body: "", status: "draft" as "draft" | "published" | "archived", source: "iAcquire approved documentation", roles: "" });
  const [questionDraft, setQuestionDraft] = React.useState({ question: "", scope: "global" as "global" | "role" | "page", role: "", routePrefix: "", sortOrder: 100, enabled: true });
  const [busy, setBusy] = React.useState(false);
  const [previewQuery, setPreviewQuery] = React.useState("How do I manage my AI employees?");
  const [previewPath, setPreviewPath] = React.useState("/workforce");
  const [previewing, setPreviewing] = React.useState(false);
  const [previewResult, setPreviewResult] = React.useState<Array<{ id: string; title: string; category: string; body: string }>>([]);
  const globalBudget = data.budgets.find((budget) => budget.orgId === null);
  const [budget, setBudget] = React.useState({ enabled: globalBudget?.enabled ?? false, orgUsd: (globalBudget?.monthlyOrgMicros ?? 0) / 1_000_000, userUsd: (globalBudget?.monthlyUserMicros ?? 0) / 1_000_000 });
  const [price, setPrice] = React.useState({ model: data.published.config.model, inputUsd: 0, outputUsd: 0, enabled: true });
  const [budgetBusy, setBudgetBusy] = React.useState(false);
  const setAttachment = <K extends keyof typeof config.attachments>(key: K, value: (typeof config.attachments)[K]) => set("attachments", { ...config.attachments, [key]: value });
  const [now] = React.useState(() => Date.now());
  const [knowledgeQuery, setKnowledgeQuery] = React.useState("");
  const [knowledgeStatus, setKnowledgeStatus] = React.useState("all");
  const changed = (Object.keys(config) as Array<keyof AqiConfig>).filter((key) => config[key] !== data.published.config[key]);
  const filteredKnowledge = data.knowledge.filter((entry) => {
    const q = knowledgeQuery.trim().toLowerCase();
    return (knowledgeStatus === "all" || entry.status === knowledgeStatus) && (!q || `${entry.title} ${entry.category} ${entry.body}`.toLowerCase().includes(q));
  });

  const set = <K extends keyof AqiConfig>(key: K, value: AqiConfig[K]) => setConfig((current) => ({ ...current, [key]: value }));

  async function saveDraft() {
    setSaving(true);
    const result = await saveAqiConfigAction(config);
    setSaving(false);
    if (!result.ok) return toast.error(result.error);
    setDraftId(result.data.id);
    toast.success(`Draft v${result.data.version} saved`, { description: "Publish it when you are ready." });
    router.refresh();
  }

  async function publish(id: string) {
    const result = await publishAqiConfigAction(id);
    if (!result.ok) return toast.error(result.error);
    toast.success("AQi configuration published");
    router.refresh();
  }

  async function previewRetrieval() {
    setPreviewing(true);
    const result = await previewAqiRetrievalAction(previewQuery, previewPath);
    setPreviewing(false);
    if (!result.ok) return toast.error(result.error);
    setPreviewResult(result.data.entries);
  }

  async function saveBudget() {
    setBudgetBusy(true);
    const result = await saveAqiBudgetAction({ orgId: null, enabled: budget.enabled, monthlyOrgUsd: budget.orgUsd, monthlyUserUsd: budget.userUsd });
    setBudgetBusy(false);
    if (!result.ok) return toast.error(result.error);
    toast.success("AQi budget saved");
    router.refresh();
  }

  async function savePrice() {
    setBudgetBusy(true);
    const result = await saveAqiModelPriceAction({ model: price.model, inputUsdPerMillion: price.inputUsd, outputUsdPerMillion: price.outputUsd, enabled: price.enabled });
    setBudgetBusy(false);
    if (!result.ok) return toast.error(result.error);
    toast.success("Model price saved");
    router.refresh();
  }

  async function testProvider() {
    setTesting(true);
    setTestResult(null);
    const result = await testAqiProviderAction(testPrompt, config);
    setTesting(false);
    if (!result.ok) return toast.error(result.error);
    setTestResult(result.data.ok ? { ok: true, text: result.data.text } : { ok: false, text: result.data.detail });
  }

  function editKnowledge(entry: (typeof data.knowledge)[number] | null) {
    setKnowledge(entry);
    setKnowledgeDraft(entry ? { title: entry.title, category: entry.category, routePrefix: entry.routePrefix ?? "", body: entry.body, status: entry.status as "draft" | "published" | "archived", source: entry.source, roles: entry.roles.join(", ") } : { title: "", category: "Platform overview", routePrefix: "", body: "", status: "draft", source: "iAcquire approved documentation", roles: "" });
  }

  async function saveKnowledge() {
    setBusy(true);
    const result = await saveAqiKnowledgeAction({
      id: knowledge?.id ?? null,
      title: knowledgeDraft.title,
      category: knowledgeDraft.category,
      routePrefix: knowledgeDraft.routePrefix || null,
      body: knowledgeDraft.body,
      status: knowledgeDraft.status,
      source: knowledgeDraft.source,
      roles: knowledgeDraft.roles.split(",").map((role) => role.trim()).filter(Boolean),
    });
    setBusy(false);
    if (!result.ok) return toast.error(result.error);
    toast.success(knowledge ? "Knowledge updated" : "Knowledge added");
    editKnowledge(null);
    router.refresh();
  }

  async function archiveKnowledge(id: string) {
    const result = await archiveAqiKnowledgeAction(id);
    if (!result.ok) return toast.error(result.error);
    toast.success("Knowledge archived");
    router.refresh();
  }

  async function saveQuestion() {
    setBusy(true);
    const result = await saveAqiQuestionAction({ ...questionDraft, role: questionDraft.role || null, routePrefix: questionDraft.routePrefix || null });
    setBusy(false);
    if (!result.ok) return toast.error(result.error);
    setQuestionDraft({ question: "", scope: "global", role: "", routePrefix: "", sortOrder: 100, enabled: true });
    toast.success("Suggested question saved");
    router.refresh();
  }

  async function deleteQuestion(id: string) {
    const result = await deleteAqiQuestionAction(id);
    if (!result.ok) return toast.error(result.error);
    toast.success("Question removed");
    router.refresh();
  }

  return (
    <div className="module-stack space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-line pb-5 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.16em] text-primary-ink"><Sparkles className="size-3" /> Platform assistant</p>
          <h1 className="text-[27px] font-semibold tracking-[-0.045em] text-ink">AQi Management</h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">Configure the assistant, its approved knowledge, suggestions and publishing. AQi is separate from AI employees and never inherits Hermes tools.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={data.health.available ? "success" : "warning"}>{data.health.available ? "Provider connected" : "No provider"}</StatusPill>
          <span className="text-[12px] text-muted">{changed.length ? `${changed.length} unpublished change${changed.length === 1 ? "" : "s"}` : "No unpublished changes"}</span>
          <Button variant="brand" onClick={() => void saveDraft()} loading={saving}><Save className="size-4" /> Save draft</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="AQi management sections">
        {TABS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} onClick={() => setTab(item.key)} className={cn("inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-medium transition", tab === item.key ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:text-ink")}>
            {item.icon}{item.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Published version" value={data.published.version ? `v${data.published.version}` : "None"} detail={data.published.version ? "Live configuration" : "Save and publish a draft"} />
          <Metric label="Knowledge entries" value={String(data.knowledge.filter((entry) => entry.status === "published").length)} detail={`${data.knowledge.length} total, including drafts`} />
          <Metric label="Messages" value={String(data.usage.messages)} detail={`${data.usage.failures} failed; ${data.usage.feedback} feedback`} />
          <Metric label="Average latency" value={data.usage.avgLatencyMs ? `${data.usage.avgLatencyMs} ms` : "Not reported"} detail={data.health.detail} />
          <Card className="sm:col-span-2 xl:col-span-4">
            <CardHeader><CardTitle>Current configuration</CardTitle><CardDescription>Only real values from the published version and the configured integration are shown.</CardDescription></CardHeader>
            <CardContent className="grid gap-3 text-[13px] sm:grid-cols-2">
              <p><span className="text-muted">Provider:</span> {data.health.provider ?? "Not configured"}</p>
              <p><span className="text-muted">Model:</span> {data.health.model ?? "Not configured"}</p>
              <p><span className="text-muted">Identity:</span> {data.published.config.identity}</p>
              <p><span className="text-muted">Tone:</span> {data.published.config.tone}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "provider" && (
        <Card>
          <CardHeader><CardTitle>Provider & model</CardTitle><CardDescription>The provider key comes from the existing Integrations connection and is never displayed. This screen controls AQi&apos;s model and response limits.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 p-3 text-[12px] sm:col-span-2"><input type="checkbox" className="mt-0.5" checked={config.modelOverride} onChange={(event) => set("modelOverride", event.target.checked)} /><span><strong className="font-semibold text-ink">Use a different model for AQi</strong><br /><span className="text-muted">When off, AQi uses the verified model from Integrations ({data.health.model ?? "not available"}). Turn this on only when the provider supports the model you enter below.</span></span></label>
            <Field label="AQi model override" htmlFor="aqi-model" hint={config.modelOverride ? "Used instead of the integration model." : "Disabled: the integration model is authoritative."}><Input id="aqi-model" value={config.model} disabled={!config.modelOverride} onChange={(event) => set("model", event.target.value)} /></Field>
            <Field label="Maximum output tokens" htmlFor="aqi-max"><Input id="aqi-max" type="number" min={128} max={2000} value={config.maxTokens} onChange={(event) => set("maxTokens", Number(event.target.value))} /></Field>
            <Field label="Maximum context tokens" htmlFor="aqi-context"><Input id="aqi-context" type="number" min={1000} max={64000} value={config.maxContextTokens} onChange={(event) => set("maxContextTokens", Number(event.target.value))} /></Field>
            <Field label="Knowledge review threshold (days)" htmlFor="aqi-freshness"><Input id="aqi-freshness" type="number" min={7} max={3650} value={config.knowledgeFreshnessDays} onChange={(event) => set("knowledgeFreshnessDays", Number(event.target.value))} /></Field>
            <Field label="Temperature" htmlFor="aqi-temp"><Input id="aqi-temp" type="number" min={0} max={1} step={0.05} value={config.temperature} onChange={(event) => set("temperature", Number(event.target.value))} /></Field>
            <div className="rounded-xl border border-line bg-surface-2 p-3 text-[12.5px] text-muted sm:col-span-2">
              <p>Integration: <strong className="text-ink-2">{data.health.connectionStatus ?? "not configured"}</strong> · AQi eligible: <strong className="text-ink-2">{data.health.eligible ? "yes" : "no"}</strong> · Model: <strong className="text-ink-2">{data.health.model ?? "not available"}</strong> · Model listed by provider: <strong className="text-ink-2">{data.health.modelListed === null ? "not checked" : data.health.modelListed ? "yes" : "no"}</strong></p>
              <p className="mt-1">Resolution: {data.health.reason}{data.health.host ? ` · Host: ${data.health.host}` : ""}. Credentials stay in the existing secure integration store and are never displayed.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "instructions" && (
        <Card>
          <CardHeader><CardTitle>Instructions & personality</CardTitle><CardDescription>These instructions sit beneath immutable security rules. They cannot grant permissions or make AQi perform actions.</CardDescription></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Assistant name" htmlFor="aqi-identity"><Input id="aqi-identity" value={config.identity} onChange={(event) => set("identity", event.target.value)} /></Field>
              <Field label="Tone" htmlFor="aqi-tone"><Input id="aqi-tone" value={config.tone} onChange={(event) => set("tone", event.target.value)} /></Field>
            </div>
            <Field label="Short description" htmlFor="aqi-desc"><Input id="aqi-desc" value={config.description} onChange={(event) => set("description", event.target.value)} /></Field>
            <Field label="Greeting" htmlFor="aqi-greeting"><Input id="aqi-greeting" value={config.greeting} onChange={(event) => set("greeting", event.target.value)} /></Field>
            <Field label="Editable guidance" htmlFor="aqi-instructions"><Textarea id="aqi-instructions" rows={6} value={config.instructions} onChange={(event) => set("instructions", event.target.value)} /></Field>
            <div className="rounded-xl border border-warning/25 bg-warning-soft p-3 text-[12.5px] text-warning-ink"><TriangleAlert className="mr-1 inline size-3.5" /> Protected policy is always appended after this text: no secrets, no cross-tenant data, no action claims and no permission bypass.</div>
          </CardContent>
        </Card>
      )}

      {tab === "conversation" && (
        <Card>
          <CardHeader><CardTitle>Conversation behavior</CardTitle><CardDescription>Controls how AQi interprets greetings, chooses length, uses page context, offers navigation and cites sources. Immutable security policy still overrides every setting.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Response verbosity" htmlFor="aqi-verbosity" hint="Adaptive uses the detected intent."><Select id="aqi-verbosity" value={config.responseVerbosity} onChange={(event) => set("responseVerbosity", event.target.value as AqiConfig["responseVerbosity"])}><option value="adaptive">Adaptive</option><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></Select></Field>
              <Field label="Greeting behavior" htmlFor="aqi-greeting-behavior"><Select id="aqi-greeting-behavior" value={config.greetingBehavior} onChange={(event) => set("greetingBehavior", event.target.value as AqiConfig["greetingBehavior"])}><option value="warm">Warm and natural</option><option value="brief">Very brief</option><option value="professional">Professional</option></Select></Field>
              <Field label="Navigation behavior" htmlFor="aqi-nav-behavior"><Select id="aqi-nav-behavior" value={config.navigationBehavior} onChange={(event) => set("navigationBehavior", event.target.value as AqiConfig["navigationBehavior"])}><option value="link_when_relevant">Clickable link when relevant</option><option value="explain_inline">Explain inline</option></Select></Field>
              <Field label="Follow-up behavior" htmlFor="aqi-followup-behavior"><Select id="aqi-followup-behavior" value={config.followUpBehavior} onChange={(event) => set("followUpBehavior", event.target.value as AqiConfig["followUpBehavior"])}><option value="when_useful">When useful</option><option value="always">Always ask</option><option value="never">Never ask</option></Select></Field>
              <Field label="Citation behavior" htmlFor="aqi-citation-behavior"><Select id="aqi-citation-behavior" value={config.citationBehavior} onChange={(event) => set("citationBehavior", event.target.value as AqiConfig["citationBehavior"])}><option value="when_relevant">Only when relevant</option><option value="always">Always</option><option value="never">Never</option></Select></Field>
            </div>
            <Field label="Safe fallback instructions" htmlFor="aqi-fallback"><Textarea id="aqi-fallback" rows={3} value={config.fallbackInstructions} onChange={(event) => set("fallbackInstructions", event.target.value)} /></Field>
            <Field label="Role-aware guidance" htmlFor="aqi-role-guidance"><Textarea id="aqi-role-guidance" rows={3} value={config.roleGuidance} onChange={(event) => set("roleGuidance", event.target.value)} /></Field>
            <div className="rounded-xl border border-warning/25 bg-warning-soft p-3 text-[12.5px] text-warning-ink"><TriangleAlert className="mr-1 inline size-3.5" /> These settings control style and usefulness, not permissions, security policy or action authority.</div>
          </CardContent>
        </Card>
      )}

      {tab === "knowledge" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Card>
            <CardHeader><div className="flex items-center justify-between gap-2"><div><CardTitle>Knowledge entries</CardTitle><CardDescription>Published entries are available to AQi; drafts stay private.</CardDescription></div><Button size="sm" variant="secondary" onClick={() => editKnowledge(null)}><Plus className="size-3.5" /> New</Button></div></CardHeader>
            <CardContent className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
              <div className="flex gap-2 pb-1">
                <Input value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} placeholder="Search knowledge" aria-label="Search knowledge entries" className="h-9 flex-1 text-[12px]" />
                <Select value={knowledgeStatus} onChange={(event) => setKnowledgeStatus(event.target.value)} aria-label="Filter knowledge by status" className="h-9 w-32 text-[12px]"><option value="all">All</option><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option></Select>
              </div>
              {filteredKnowledge.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-line p-3">
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" className="min-w-0 text-left" onClick={() => editKnowledge(entry)}>
                      <p className="truncate text-[13px] font-medium">{entry.title}</p>
                      <p className="mt-0.5 text-[11px] text-muted">{entry.category} · {entry.routePrefix ?? "all pages"} · updated <span suppressHydrationWarning>{relativeTime(entry.updatedAt)}</span></p>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill size="sm" tone={entry.status === "published" ? "success" : entry.status === "archived" ? "neutral" : "warning"}>{entry.status}</StatusPill>
                      {entry.status === "published" && now - new Date(entry.updatedAt).getTime() > data.published.config.knowledgeFreshnessDays * 86_400_000 && <StatusPill size="sm" tone="warning">review stale</StatusPill>}
                    </div>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => editKnowledge(entry)}>Edit</Button>
                    {entry.status !== "archived" && <Button size="sm" variant="ghost" onClick={() => void archiveKnowledge(entry.id)}><Archive className="size-3.5" /> Archive</Button>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{knowledge ? `Edit: ${knowledge.title}` : "New knowledge entry"}</CardTitle><CardDescription>Approved, versioned platform knowledge. Never include client data or secrets.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Title" htmlFor="k-title"><Input id="k-title" value={knowledgeDraft.title} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, title: event.target.value })} /></Field>
                <Field label="Category" htmlFor="k-cat"><Input id="k-cat" value={knowledgeDraft.category} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, category: event.target.value })} /></Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Route (optional)" htmlFor="k-route"><Input id="k-route" placeholder="/workforce" value={knowledgeDraft.routePrefix} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, routePrefix: event.target.value })} /></Field>
                <Field label="Status" htmlFor="k-status"><Select id="k-status" value={knowledgeDraft.status} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, status: event.target.value as typeof knowledgeDraft.status })}><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></Select></Field>
              </div>
              <Field label="Body" htmlFor="k-body"><Textarea id="k-body" rows={8} value={knowledgeDraft.body} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, body: event.target.value })} /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Roles (comma separated, blank = all)" htmlFor="k-roles"><Input id="k-roles" value={knowledgeDraft.roles} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, roles: event.target.value })} /></Field>
                <Field label="Source" htmlFor="k-source"><Input id="k-source" value={knowledgeDraft.source} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, source: event.target.value })} /></Field>
              </div>
              <Button variant="brand" onClick={() => void saveKnowledge()} loading={busy}><Save className="size-4" /> Save knowledge</Button>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "knowledge" && (
        <Card>
          <CardHeader><CardTitle>Preview retrieval</CardTitle><CardDescription>Runs the published retriever for this question and route. It shows the exact entries AQi would receive before any answer is generated.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
              <Field label="Question" htmlFor="preview-query"><Input id="preview-query" value={previewQuery} onChange={(event) => setPreviewQuery(event.target.value)} /></Field>
              <Field label="Page route" htmlFor="preview-path"><Input id="preview-path" placeholder="/workforce" value={previewPath} onChange={(event) => setPreviewPath(event.target.value)} /></Field>
              <div className="flex items-end"><Button variant="secondary" onClick={() => void previewRetrieval()} loading={previewing}>Preview</Button></div>
            </div>
            {previewResult.length ? (
              <ul className="space-y-2">
                {previewResult.map((entry) => (
                  <li key={entry.id} className="rounded-xl border border-line p-3">
                    <p className="text-[13px] font-medium">{entry.title} <span className="font-normal text-muted">· {entry.category}</span></p>
                    <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-muted">{entry.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-muted">Run a preview to see matching published knowledge. Draft and archived entries never appear.</p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "questions" && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Configured questions</CardTitle><CardDescription>Only enabled questions that match the person&apos;s role or page appear.</CardDescription></CardHeader>
            <CardContent className="space-y-2">
              {data.questions.map((question) => (
                <div key={question.id} className="flex items-start justify-between gap-2 rounded-xl border border-line p-3">
                  <div><p className="text-[13px]">{question.question}</p><p className="mt-0.5 text-[11px] text-muted">{question.scope}{question.role ? ` · ${question.role}` : ""}{question.routePrefix ? ` · ${question.routePrefix}` : ""} · order {question.sortOrder}</p></div>
                  <div className="flex shrink-0 gap-1"><StatusPill size="sm" tone={question.enabled ? "success" : "neutral"}>{question.enabled ? "on" : "off"}</StatusPill><button type="button" onClick={() => void deleteQuestion(question.id)} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink" aria-label={`Delete ${question.question}`}><Trash2 className="size-3.5" /></button></div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Add a question</CardTitle><CardDescription>Global questions show everywhere; page questions only on that route.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <Field label="Question" htmlFor="q-text"><Input id="q-text" value={questionDraft.question} onChange={(event) => setQuestionDraft({ ...questionDraft, question: event.target.value })} /></Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Scope" htmlFor="q-scope"><Select id="q-scope" value={questionDraft.scope} onChange={(event) => setQuestionDraft({ ...questionDraft, scope: event.target.value as typeof questionDraft.scope })}><option value="global">Global</option><option value="role">Role</option><option value="page">Page</option></Select></Field>
                <Field label="Role" htmlFor="q-role"><Input id="q-role" placeholder="viewer" value={questionDraft.role} onChange={(event) => setQuestionDraft({ ...questionDraft, role: event.target.value })} /></Field>
                <Field label="Route" htmlFor="q-route"><Input id="q-route" placeholder="/workforce" value={questionDraft.routePrefix} onChange={(event) => setQuestionDraft({ ...questionDraft, routePrefix: event.target.value })} /></Field>
              </div>
              <Button variant="brand" onClick={() => void saveQuestion()} loading={busy}><Plus className="size-4" /> Add question</Button>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "testing" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Test the configured provider</CardTitle><CardDescription>This calls the real provider with the configuration currently in this editor (including unsaved changes) and does not save a conversation.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Conversation probes</p>
                <div className="flex flex-wrap gap-1.5">{["hi", "hey", "hello", "what's up", "can you help me?", "Where are integrations?"].map((probe) => <button key={probe} type="button" onClick={() => setTestPrompt(probe)} className="rounded-full border border-line px-2 py-1 text-[10.5px] text-muted hover:bg-surface-2 hover:text-ink">{probe}</button>)}</div>
              </div>
              <Field label="Test question" htmlFor="test-prompt"><Textarea id="test-prompt" rows={3} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} /></Field>
              <Button variant="brand" onClick={() => void testProvider()} loading={testing}><FlaskConical className="size-4" /> Run test</Button>
              {testResult && <div className={cn("rounded-xl border p-3 text-[12.5px]", testResult.ok ? "border-success/25 bg-success-soft text-success-ink" : "border-danger/25 bg-danger-soft text-danger-ink")}>{testResult.text}</div>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Publishing</CardTitle><CardDescription>Save a draft, test it, then publish. Publishing archives the previous live version.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[13px] text-muted">Current published version: <strong className="text-ink">{data.published.version ? `v${data.published.version}` : "none"}</strong></p>
              {draftId && <p className="text-[13px] text-muted">Saved draft: <strong className="text-ink">ready to publish</strong></p>}
              <Button variant="brand" disabled={!draftId} onClick={() => draftId && void publish(draftId)}><CheckCircle2 className="size-4" /> Publish saved draft</Button>
              {!draftId && <p className="text-[12px] text-muted">Use Save draft above first.</p>}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Draft compared with published</CardTitle><CardDescription>Fields that will change when this draft is published.</CardDescription></CardHeader>
            <CardContent>
              {changed.length === 0 ? <p className="text-[12.5px] text-muted">The editor matches the published configuration.</p> : (
                <ul className="space-y-2">
                  {changed.map((key) => (
                    <li key={key} className="rounded-xl border border-line p-3 text-[12.5px]">
                      <p className="font-medium text-ink">{key}</p>
                      <p className="mt-1 text-muted"><span className="text-faint">Published:</span> {String(data.published.config[key]).slice(0, 180)}</p>
                      <p className="mt-0.5 text-ink-2"><span className="text-faint">Draft:</span> {String(config[key]).slice(0, 180)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "history" && (
        <Card>
          <CardHeader><CardTitle>Configuration versions</CardTitle><CardDescription>Every save is audited. A published version can be restored by publishing it again.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {data.versions.map((version) => (
              <div key={version.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
                <div><p className="text-[13px] font-medium">v{version.version} <StatusPill size="sm" tone={version.status === "published" ? "success" : version.status === "draft" ? "warning" : "neutral"}>{version.status}</StatusPill></p><p className="mt-0.5 text-[11px] text-muted">{version.notes ?? "No note"} · <span suppressHydrationWarning>{formatDateTime(version.createdAt)}</span></p></div>
                {version.status !== "published" && <Button size="sm" variant="secondary" onClick={() => void publish(version.id)}><RotateCcw className="size-3.5" /> {version.status === "archived" ? "Restore" : "Publish"}</Button>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {tab === "budgets" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Global AQi budget</CardTitle><CardDescription>Server-side monthly limits. A request is rejected before the provider call when the budget is exhausted. $0 means no cap while enabled; leave budgets off until prices are configured.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span>Enforce AQi budgets</span><input type="checkbox" checked={budget.enabled} onChange={(event) => setBudget({ ...budget, enabled: event.target.checked })} aria-label="Enforce AQi budgets" /></label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Workspace monthly budget (USD)" htmlFor="aqi-org-budget"><Input id="aqi-org-budget" type="number" min={0} step="0.01" value={budget.orgUsd} onChange={(event) => setBudget({ ...budget, orgUsd: Number(event.target.value) })} /></Field>
                <Field label="Per-user monthly budget (USD)" htmlFor="aqi-user-budget"><Input id="aqi-user-budget" type="number" min={0} step="0.01" value={budget.userUsd} onChange={(event) => setBudget({ ...budget, userUsd: Number(event.target.value) })} /></Field>
              </div>
              <Button variant="brand" onClick={() => void saveBudget()} loading={budgetBusy}><Save className="size-4" /> Save budget</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Model pricing</CardTitle><CardDescription>Prices are configured per million tokens and used only for estimates. Missing pricing blocks budgeted calls; it never guesses a provider price.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <Field label="Model" htmlFor="price-model"><Input id="price-model" value={price.model} onChange={(event) => setPrice({ ...price, model: event.target.value })} /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Input USD / 1M tokens" htmlFor="price-input"><Input id="price-input" type="number" min={0} step="0.0001" value={price.inputUsd} onChange={(event) => setPrice({ ...price, inputUsd: Number(event.target.value) })} /></Field>
                <Field label="Output USD / 1M tokens" htmlFor="price-output"><Input id="price-output" type="number" min={0} step="0.0001" value={price.outputUsd} onChange={(event) => setPrice({ ...price, outputUsd: Number(event.target.value) })} /></Field>
              </div>
              <Button variant="secondary" onClick={() => void savePrice()} loading={budgetBusy}><Save className="size-4" /> Save model price</Button>
              <div className="border-t border-line pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Configured prices</p>
                {data.prices.length === 0 ? <p className="mt-2 text-[12px] text-muted">No model prices configured. Budgeted calls stay blocked until a price is saved.</p> : (
                  <ul className="mt-2 space-y-1">
                    {data.prices.map((item) => <li key={item.model} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px]"><span className="font-medium">{item.model}</span><span className="text-muted">${(item.inputMicrosPerMillion / 1_000_000).toFixed(4)} in · ${(item.outputMicrosPerMillion / 1_000_000).toFixed(4)} out {item.enabled ? "" : "· off"}</span></li>)}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "attachments" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Images</CardTitle><CardDescription><span className="text-ink-2">Limits are enforced by the upload endpoint, not just the browser.</span></CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span>Allow image uploads</span><input type="checkbox" checked={config.attachments.imagesEnabled} onChange={(event) => setAttachment("imagesEnabled", event.target.checked)} /></label>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Max image MB" htmlFor="aqi-img-mb"><Input id="aqi-img-mb" type="number" min={1} max={10} value={config.attachments.imageMaxMb} onChange={(event) => setAttachment("imageMaxMb", Number(event.target.value))} /></Field><Field label="Max images / message" htmlFor="aqi-img-n"><Input id="aqi-img-n" type="number" min={1} max={5} value={config.attachments.maxImages} onChange={(event) => setAttachment("maxImages", Number(event.target.value))} /></Field></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Documents and video</CardTitle><CardDescription><span className="text-ink-2">Documents use the existing bounded PDF/DOCX/TXT/CSV extraction pipeline. Video is stored and playable; AI video analysis is unavailable.</span></CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span>Allow document uploads</span><input type="checkbox" checked={config.attachments.documentsEnabled} onChange={(event) => setAttachment("documentsEnabled", event.target.checked)} /></label>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Max document MB" htmlFor="aqi-doc-mb"><Input id="aqi-doc-mb" type="number" min={1} max={20} value={config.attachments.documentMaxMb} onChange={(event) => setAttachment("documentMaxMb", Number(event.target.value))} /></Field><Field label="Max documents / message" htmlFor="aqi-doc-n"><Input id="aqi-doc-n" type="number" min={1} max={5} value={config.attachments.maxDocuments} onChange={(event) => setAttachment("maxDocuments", Number(event.target.value))} /></Field></div>
              <label className="flex items-center justify-between gap-3 rounded-xl border border-line p-3 text-[13px]"><span>Allow video uploads</span><input type="checkbox" checked={config.attachments.videosEnabled} onChange={(event) => setAttachment("videosEnabled", event.target.checked)} /></label>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Max video MB" htmlFor="aqi-vid-mb"><Input id="aqi-vid-mb" type="number" min={1} max={50} value={config.attachments.videoMaxMb} onChange={(event) => setAttachment("videoMaxMb", Number(event.target.value))} /></Field><Field label="Max video seconds" htmlFor="aqi-vid-sec"><Input id="aqi-vid-sec" type="number" min={1} max={60} value={config.attachments.videoMaxSeconds} onChange={(event) => setAttachment("videoMaxSeconds", Number(event.target.value))} /></Field></div>
              <Field label="Max documents context tokens" htmlFor="aqi-att-context"><Input id="aqi-att-context" type="number" min={500} max={16000} value={config.attachments.attachmentContextTokens} onChange={(event) => setAttachment("attachmentContextTokens", Number(event.target.value))} /></Field>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Workspace storage quota (MB)" htmlFor="aqi-att-quota"><Input id="aqi-att-quota" type="number" min={1} max={100000} value={config.attachments.storageQuotaMb} onChange={(event) => setAttachment("storageQuotaMb", Number(event.target.value))} /></Field><Field label="Attachment retention (days)" htmlFor="aqi-att-retention"><Input id="aqi-att-retention" type="number" min={1} max={3650} value={config.attachments.retentionDays} onChange={(event) => setAttachment("retentionDays", Number(event.target.value))} /></Field></div>
              <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-[12px] text-ink-2"><p><strong className="text-ink">Image understanding:</strong> unavailable with the current model; images are uploaded and previewed but not sent as vision payloads.</p><p><strong className="text-ink-2">Video understanding:</strong> unavailable; video is stored and playable only.</p><p><strong className="text-ink-2">Retention:</strong> cleanup is server-owned; this setting records the intended policy but does not delete files automatically.</p></div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "usage" && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Messages" value={String(data.usage.messages)} detail="Recorded AQi turns" />
          <Metric label="Failed turns" value={String(data.usage.failures)} detail="Provider or empty responses" />
          <Metric label="Input tokens" value={data.usage.inputTokens.toLocaleString()} detail="Estimated when provider omits usage" />
          <Metric label="Output tokens" value={data.usage.outputTokens.toLocaleString()} detail="Estimated when provider omits usage" />
          <Metric label="Recorded cost" value={`$${(data.usage.costMicros / 1_000_000).toFixed(4)}`} detail="Based on configured model prices" />
          <Metric label="Reserved" value={`$${(data.usage.reservedMicros / 1_000_000).toFixed(4)}`} detail="In-flight budget reservations" />
          <Metric label="Estimated charges" value={String(data.usage.estimatedCosts)} detail="Provider omitted usage; token estimate used" />
          <Metric label="Rate-limited turns" value={String(data.usage.rateLimits)} detail="Rejected before the provider call" />
          <Metric label="Helpful feedback" value={String(data.usage.helpful)} detail="Persisted thumbs-up ratings" />
          <Metric label="Needs improvement" value={String(data.usage.notHelpful)} detail="Persisted thumbs-down ratings" />
          <Card className="sm:col-span-2 xl:col-span-4"><CardHeader><CardTitle>Health</CardTitle><CardDescription>{data.health.detail}</CardDescription></CardHeader><CardContent className="text-[13px]"><p>Provider: {data.health.provider ?? "not configured"} · Model: {data.health.model ?? "not configured"}</p><p className="mt-1 text-muted">Costs are estimates from configured pricing; no provider invoice is implied. A request that fails before usage is reported is released without a cost charge.</p></CardContent></Card>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <Card><CardContent className="pt-5"><p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p><p className="mt-1 text-[24px] font-semibold tracking-tight text-ink">{value}</p><p className="mt-1 text-[11.5px] leading-relaxed text-muted">{detail}</p></CardContent></Card>;
}
