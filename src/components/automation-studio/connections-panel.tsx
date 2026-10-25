"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, CheckCircle2, Globe, History, KeyRound, MessageSquareText, MoreHorizontal, Plus, RefreshCcwDot, Send, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import { connectionCallsAction, createConnectionAction, revokeConnectionAction, rotateConnectionAction, testConnectionAction } from "@/app/actions/automation-studio";
import { CONNECTION_KIND_LABELS, MAX_LIVE_CONNECTIONS, NOT_YET_AVAILABLE_CONNECTIONS, STATUS_LABELS, type ConnectionStatus, type ConnectionView, type HttpSettings } from "@/lib/automation-studio/connections";
import { HTTP_METHODS } from "@/lib/automation-studio/outbound";

const TONE: Record<ConnectionStatus, "success" | "warning" | "danger" | "neutral"> = { active: "success", unverified: "warning", needs_attention: "danger", revoked: "neutral" };
type Calls = Array<{ at: string; origin: string; method: string; host: string; path: string; outcome: string; httpStatus: number | null; durationMs: number | null; detail: string | null }>;

/** The workspace's connections: add, verify (a confirmed test), rotate, revoke, and read each one's call log. No secret is ever shown after it is typed. */
export function ConnectionsPanel({ connections, timezone, canManage, planReason }: {
  connections: ConnectionView[];
  timezone: string;
  canManage: boolean;
  /** Why changing connections isn't possible right now (no plan), or null. Revoking is always possible. */
  planReason: string | null;
}) {
  const [adding, setAdding] = React.useState(false);
  const [testing, setTesting] = React.useState<ConnectionView | null>(null);
  const [rotating, setRotating] = React.useState<ConnectionView | null>(null);
  const [revoking, setRevoking] = React.useState<ConnectionView | null>(null);
  const [log, setLog] = React.useState<ConnectionView | null>(null);
  const [results, setResults] = React.useState<Record<string, { ok: boolean; detail: string }>>({});
  const { run, busy } = useCrmAction();
  const live = connections.filter((c) => c.status !== "revoked");
  const revoked = connections.filter((c) => c.status === "revoked");
  const canChange = canManage && !planReason;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/automation-studio" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink"><ArrowLeft className="size-3.5" aria-hidden />Automation Studio</Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold tracking-tight text-ink">Connections</h1>
            <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">
              A connection lets your automations call an outside system or post to Slack. The address and the credentials live here, encrypted, and are never shown again or given to the AI builder. Every connection is checked with a test you confirm before an automation can use it.
            </p>
          </div>
          {canManage && (
            <Button variant="brand" onClick={() => setAdding(true)} disabled={!canChange || live.length >= MAX_LIVE_CONNECTIONS}>
              <Plus className="size-4" aria-hidden />Add connection
            </Button>
          )}
        </div>
        {planReason && <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink" role="note">{planReason} You can still revoke a connection.</p>}
        {!canManage && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-muted" role="note">Setting up connections needs the “Build and change automations” permission. Ask the owner of your workspace.</p>}
      </div>

      {live.length ? (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Connections">
          {live.map((c) => {
            const result = results[c.id];
            const http = c.kind === "http" ? (c.settings as HttpSettings) : null;
            return (
              <li key={c.id} className="min-w-0">
                <Card className="flex h-full min-w-0 flex-col p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2">
                        {c.kind === "http" ? <Globe className="size-4.5" aria-hidden /> : <MessageSquareText className="size-4.5" aria-hidden />}
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-[14.5px] font-semibold text-ink">{c.name}</h2>
                        <p className="truncate text-[12px] text-muted">{CONNECTION_KIND_LABELS[c.kind]} · {c.host}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge tone={TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
                      {canManage && (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${c.name}`}><MoreHorizontal className="size-4" /></Button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem disabled={!canChange} onSelect={() => setRotating(c)}><RefreshCcwDot className="size-4" aria-hidden />{c.kind === "slack_webhook" ? "Replace webhook address" : "Replace secret"}</MenuItem>
                            <MenuSeparator />
                            <MenuItem destructive onSelect={() => setRevoking(c)}><Trash2 className="size-4" aria-hidden />Revoke</MenuItem>
                          </MenuContent>
                        </Menu>
                      )}
                    </div>
                  </div>

                  {c.status === "needs_attention" && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl bg-danger-soft p-2.5 text-[13px] leading-relaxed text-danger-ink">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>{c.statusDetail ?? "Its recent calls failed."} Automations that use it wait until you check it. Replace the secret if it changed, then send the test again.</span>
                    </p>
                  )}
                  {c.status === "unverified" && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-[13px] leading-relaxed text-warning-ink">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>Not verified yet. Automations that use it wait until you send the test and it goes through.</span>
                    </p>
                  )}

                  <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px] [&_dd]:min-w-0 [&_dd]:break-words">
                    {http && (
                      <>
                        <dt className="text-muted">Allowed methods</dt>
                        <dd className="text-ink-2">{http.methods.join(", ")}</dd>
                        <dt className="text-muted">Sends credentials</dt>
                        <dd className="text-ink-2">{http.auth.type === "none" ? "No" : http.auth.type === "bearer" ? "As a bearer token" : http.auth.type === "header" ? `In the ${http.auth.name} header` : `As basic auth (${http.auth.username})`}</dd>
                      </>
                    )}
                    {c.kind === "slack_webhook" && (c.settings as { channelLabel?: string }).channelLabel ? (
                      <>
                        <dt className="text-muted">Posts to</dt>
                        <dd className="text-ink-2">{(c.settings as { channelLabel: string }).channelLabel}</dd>
                      </>
                    ) : null}
                    <dt className="text-muted">Secret</dt>
                    <dd className="font-mono text-ink-2">{c.secretHint ? `…${c.secretHint}` : "None"}{c.secretVersion > 1 ? ` · replaced ${c.secretVersion - 1} time${c.secretVersion === 2 ? "" : "s"}` : ""}</dd>
                    <dt className="text-muted">Verified</dt>
                    <dd className="text-ink-2">{c.verifiedAt ? <RelativeTime iso={c.verifiedAt} timezone={timezone} /> : "Not yet"}</dd>
                    <dt className="text-muted">Last used</dt>
                    <dd className="text-ink-2">{c.lastUsedAt ? <RelativeTime iso={c.lastUsedAt} timezone={timezone} /> : "Never"}</dd>
                  </dl>

                  <div aria-live="polite">
                    {result && (
                      <p className={`mt-3 flex items-start gap-2 text-[13px] leading-relaxed ${result.ok ? "text-success-ink" : "text-danger-ink"}`}>
                        {result.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                        <span>{result.ok ? "Verified." : "The test didn’t go through."} {result.detail}</span>
                      </p>
                    )}
                  </div>

                  <div className="mt-auto flex flex-wrap gap-2 pt-4">
                    {canManage && (
                      <Button variant={c.status === "active" ? "secondary" : "primary"} size="sm" onClick={() => setTesting(c)} disabled={!canChange}>
                        <Send className="size-3.5" aria-hidden />{c.status === "active" ? "Send test again" : "Verify with a test"}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setLog(c)}><History className="size-3.5" aria-hidden />Recent calls</Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : (
        <Card className="p-0">
          <EmptyState
            compact
            icon={<KeyRound className="size-5" aria-hidden />}
            title="No connections yet"
            description={canManage ? "Add a Slack webhook to get a message when something happens, or an HTTP connection to send data to another system." : "Owners and managers can add connections."}
          />
        </Card>
      )}

      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Only public https addresses can be called. Private networks, redirects and credentials in an address are refused, calls are limited in size, time and number, and nothing an automation reads from another system is ever treated as an instruction.
          Slack works through incoming webhooks, which post to one channel. Signing in with Slack to pick channels isn’t available yet.
        </span>
      </p>

      <section aria-labelledby="not-yet-title" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 id="not-yet-title" className="text-[14px] font-semibold text-ink">Not available yet</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          These need iAcquire to register an app with the provider first, so they can’t be connected from here today. Nothing below is half-connected.
          Meanwhile an HTTP connection reaches any service that has a web API, and Zapier, Make or n8n can start your automations through a webhook.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {NOT_YET_AVAILABLE_CONNECTIONS.map((a) => (
            <li key={a.key} className="min-w-0 rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line">
              <p className="text-[14px] font-medium text-ink">{a.name}</p>
              <p className="mt-0.5 text-[13px] text-ink-2">{a.what}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{a.needs}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-muted">Need one of these first? <Link href="/support" className="font-medium text-primary hover:underline">Tell support</Link> which, so it can be planned.</p>
      </section>

      {revoked.length > 0 && (
        <details className="rounded-2xl border border-line bg-surface p-4">
          <summary className="cursor-pointer text-[14px] font-medium text-ink-2">Revoked connections ({revoked.length})</summary>
          <ul className="mt-3 space-y-2">
            {revoked.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-[14px] text-muted">
                <span className="truncate">{c.name} · {c.host}</span>
                <span>Revoked {c.revokedAt ? <RelativeTime iso={c.revokedAt} timezone={timezone} /> : ""}. Its secret was erased.</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {adding && <AddDialog onClose={() => setAdding(false)} />}
      {testing && (
        <TestDialog
          connection={testing}
          onClose={() => setTesting(null)}
          onResult={(id, r) => {
            setResults((x) => ({ ...x, [id]: r }));
            setTesting(null);
          }}
        />
      )}
      {rotating && <RotateDialog connection={rotating} onClose={() => setRotating(null)} />}
      {log && <CallsDialog connection={log} timezone={timezone} onClose={() => setLog(null)} />}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking ? `Revoke “${revoking.name}”?` : "Revoke connection?"}
        description="Its secret is erased for good and it can’t be used again. Automations that use it stop at that step with a clear message until you point them at another connection."
        confirmLabel="Revoke connection"
        danger
        loading={busy("revoke")}
        onConfirm={async () => {
          if (!revoking) return;
          const out = await run("revoke", () => revokeConnectionAction(revoking.id), (d) => (d.workflowsUsingIt ? `Revoked. ${d.workflowsUsingIt} automation${d.workflowsUsingIt === 1 ? " uses" : "s use"} it and will stop at that step.` : "Connection revoked."));
          if (out) setRevoking(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function AddDialog({ onClose }: { onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [kind, setKind] = React.useState<"http" | "slack_webhook">("slack_webhook");
  const [name, setName] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("https://");
  const [methods, setMethods] = React.useState<string[]>(["GET", "POST"]);
  const [auth, setAuth] = React.useState<"none" | "bearer" | "header" | "basic">("bearer");
  const [headerName, setHeaderName] = React.useState("X-Api-Key");
  const [username, setUsername] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [testPath, setTestPath] = React.useState("/");
  const [webhookUrl, setWebhookUrl] = React.useState("");
  const [channelLabel, setChannelLabel] = React.useState("");

  const submit = async () => {
    const input = kind === "slack_webhook"
      ? { kind, name, webhookUrl, channelLabel: channelLabel || undefined }
      : {
          kind, name, baseUrl, methods, testPath: testPath || undefined,
          auth: auth === "header" ? { type: "header", name: headerName } : auth === "basic" ? { type: "basic", username } : { type: auth },
          secret: auth === "none" ? undefined : secret,
        };
    const out = await run("add", () => createConnectionAction(input), "Connection saved. Verify it with a test before an automation can use it.");
    if (out) {
      setSecret("");
      setWebhookUrl("");
      onClose();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a connection"
      description="The secret is encrypted when you save it and is never shown again."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy("add")} onClick={() => void submit()} disabled={!name.trim()}>Save connection</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} autoComplete="off">
        <div role="radiogroup" aria-label="Kind of connection" className="grid grid-cols-2 gap-2">
          {(["slack_webhook", "http"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[14px] font-medium transition-colors ${kind === k ? "border-primary bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong"}`}>
              {k === "http" ? <Globe className="size-4" aria-hidden /> : <MessageSquareText className="size-4" aria-hidden />}
              {k === "http" ? "HTTP API" : "Slack"}
            </button>
          ))}
        </div>
        <Field label="Name" htmlFor="conn-name" hint="Shown when you pick it in an automation.">
          <Input id="conn-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={kind === "http" ? "Orders system" : "Sales channel"} />
        </Field>
        {kind === "slack_webhook" ? (
          <>
            <Field label="Slack webhook address" htmlFor="conn-webhook" hint="In Slack, create an incoming webhook for the channel and paste its address. It starts with https://hooks.slack.com/services/.">
              <Input id="conn-webhook" type="password" autoComplete="off" spellCheck={false} value={webhookUrl} maxLength={300} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
            </Field>
            <Field label="Channel name" htmlFor="conn-channel" optional hint="Only a reminder for you of where it posts.">
              <Input id="conn-channel" value={channelLabel} maxLength={60} onChange={(e) => setChannelLabel(e.target.value)} placeholder="#sales" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Address" htmlFor="conn-base" hint="An https address on the public internet. Every call goes to this host only.">
              <Input id="conn-base" value={baseUrl} maxLength={300} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
            </Field>
            <fieldset>
              <legend className="mb-1.5 text-[14px] font-medium text-ink-2">Allowed methods</legend>
              <div className="flex flex-wrap gap-2">
                {HTTP_METHODS.map((m) => (
                  <label key={m} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium ${methods.includes(m) ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-ink-2"}`}>
                    <input type="checkbox" className="sr-only" checked={methods.includes(m)} onChange={() => setMethods((x) => (x.includes(m) ? x.filter((y) => y !== m) : [...x, m]))} />
                    {m}
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[13px] text-muted">An automation can use only the methods you allow here.</p>
            </fieldset>
            <Field label="How to sign requests" htmlFor="conn-auth">
              <Select id="conn-auth" value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}>
                <option value="bearer">Bearer token</option>
                <option value="header">A custom header</option>
                <option value="basic">Username and password</option>
                <option value="none">No credentials</option>
              </Select>
            </Field>
            {auth === "header" && (
              <Field label="Header name" htmlFor="conn-header"><Input id="conn-header" value={headerName} maxLength={60} onChange={(e) => setHeaderName(e.target.value)} /></Field>
            )}
            {auth === "basic" && (
              <Field label="Username" htmlFor="conn-user"><Input id="conn-user" value={username} maxLength={120} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></Field>
            )}
            {auth !== "none" && (
              <Field label={auth === "basic" ? "Password" : auth === "header" ? "Header value" : "Token"} htmlFor="conn-secret">
                <Input id="conn-secret" type="password" autoComplete="new-password" spellCheck={false} value={secret} maxLength={2000} onChange={(e) => setSecret(e.target.value)} />
              </Field>
            )}
            <Field label="Test path" htmlFor="conn-test" hint="The test sends one GET request to this path. Pick one that only reads, such as a status or account page.">
              <Input id="conn-test" value={testPath} maxLength={300} onChange={(e) => setTestPath(e.target.value)} placeholder="/ping" spellCheck={false} />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}

function TestDialog({ connection, onClose, onResult }: { connection: ConnectionView; onClose: () => void; onResult: (id: string, r: { ok: boolean; detail: string }) => void }) {
  const { run, busy } = useCrmAction();
  const http = connection.kind === "http" ? (connection.settings as HttpSettings) : null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Send a test through “${connection.name}”?`}
      description={
        http
          ? <>iAcquire will send <strong>one GET request</strong> to <span className="font-mono">{http.host}{http.pathPrefix}{http.testPath}</span>, signed with this connection’s credentials. It should only read. Nothing else is sent.</>
          : <>iAcquire will post <strong>one message</strong> to the Slack channel this webhook belongs to. It says it is a test from Automation Studio. Everyone in that channel will see it.</>
      }
      confirmLabel="Send the test"
      loading={busy("test")}
      onConfirm={async () => {
        const out = await run("test", () => testConnectionAction(connection.id, { confirmed: true }));
        if (out && typeof out === "object") {
          if (out.ok) toast.success("Verified. Automations can use this connection now.");
          else toast.error("The test didn’t go through.");
          onResult(connection.id, { ok: out.ok, detail: out.detail });
        }
      }}
    />
  );
}

function RotateDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [value, setValue] = React.useState("");
  const slack = connection.kind === "slack_webhook";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={slack ? "Replace the webhook address" : "Replace the secret"}
      description="The old one stops working immediately and is erased. The connection must be verified again before an automation can use it."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy("rotate")}
            disabled={!value.trim()}
            onClick={async () => {
              if (await run("rotate", () => rotateConnectionAction(connection.id, value), "Replaced. Send the test to verify it.")) {
                setValue("");
                onClose();
              }
            }}
          >
            Replace
          </Button>
        </>
      }
    >
      <Field label={slack ? "New webhook address" : "New secret"} htmlFor="conn-rotate">
        <Input id="conn-rotate" type="password" autoComplete="new-password" spellCheck={false} value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function CallsDialog({ connection, timezone, onClose }: { connection: ConnectionView; timezone: string; onClose: () => void }) {
  const [calls, setCalls] = React.useState<Calls | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    void connectionCallsAction(connection.id).then((r) => {
      if (!live) return;
      if (r.ok) setCalls(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [connection.id]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Recent calls: ${connection.name}`} description="Where each call went and how it ended, for the last 30 days. What was sent and received isn’t kept." size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {error ? <p className="text-[14px] text-danger-ink" role="alert">{error}</p> : calls === null ? <p className="text-[14px] text-muted">Loading…</p> : calls.length === 0 ? <p className="text-[14px] text-muted">Nothing has been sent through this connection yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Recent calls</caption>
            <thead className="text-muted"><tr><th className="py-1.5 pr-3 font-medium">When</th><th className="pr-3 font-medium">What</th><th className="pr-3 font-medium">Result</th><th className="font-medium">Time</th></tr></thead>
            <tbody>
              {calls.map((c, i) => (
                <tr key={i} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 text-ink-2"><RelativeTime iso={c.at} timezone={timezone} /></td>
                  <td className="pr-3 font-mono text-ink-2">{c.method} {c.host}{c.path}{c.origin === "test" ? " (test)" : ""}</td>
                  <td className="pr-3"><span className={c.outcome === "sent" ? "text-success-ink" : c.outcome === "blocked" ? "text-warning-ink" : "text-danger-ink"}>{c.outcome}{c.httpStatus ? ` · ${c.httpStatus}` : ""}</span>{c.detail && c.outcome !== "sent" ? <span className="block text-muted">{c.detail}</span> : null}</td>
                  <td className="text-ink-2">{c.durationMs !== null ? `${c.durationMs} ms` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
