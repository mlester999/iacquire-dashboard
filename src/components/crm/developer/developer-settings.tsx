"use client";

import * as React from "react";
import { BookOpen, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { PageTitle, ReadOnlyNotice } from "@/components/crm/ui";
import type { CrmScope } from "@/server/crm/page";
import type { ApiKeyView } from "@/server/crm/api-keys";
import type { WebhookSubscriptionView } from "@/server/crm/webhooks";
import { ApiKeysSection, type ScopeInfo } from "./api-keys-section";
import { WebhooksSection } from "./webhooks-section";
import type { EventInfo } from "./webhook-dialog";
import { CopyButton, CopyField } from "./shared";

export interface DeveloperSettingsProps {
  scope: CrmScope;
  keys: ApiKeyView[];
  subscriptions: WebhookSubscriptionView[];
  scopes: ScopeInfo[];
  events: EventInfo[];
  apiBase: string;
  apiVersion: string;
  limits: { maxKeys: number; maxSubscriptions: number; autoDisableAfter: number; requestsPerMinute: number; expiryChoices: number[] };
  canManage: boolean;
}

const VERIFY_SNIPPET = `import crypto from "node:crypto";

// rawBody: the request body exactly as received (a string, before JSON.parse).
function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const got = Buffer.from(parts.v1 ?? "");
  return got.length === expected.length && crypto.timingSafeEqual(got, Buffer.from(expected));
}`;

/** CRM Settings → API & Webhooks: scoped API keys, signed webhooks with their delivery log, and a short reference for developers. */
export function DeveloperSettings({ scope, keys, subscriptions, scopes, events, apiBase, apiVersion, limits, canManage }: DeveloperSettingsProps) {
  return (
    <div className="space-y-8">
      <PageTitle
        title="API & Webhooks"
        description="Connect your own apps and tools to this CRM. API keys let them read and change records with only the permissions you choose; webhooks tell them the moment something happens."
      />
      {!canManage && <ReadOnlyNotice>Only the workspace owner and managers can create keys and webhooks.</ReadOnlyNotice>}

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><BookOpen className="size-4.5" aria-hidden /></span>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">For developers</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">
                Send the key as a bearer token. Responses are JSON; lists are paged with <span className="font-mono text-[12px]">limit</span> and <span className="font-mono text-[12px]">cursor</span>; creates accept an <span className="font-mono text-[12px]">Idempotency-Key</span> header. Each key may make {limits.requestsPerMinute} requests a minute. API version {apiVersion}.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1.5 text-[13px] font-medium text-ink-2">Base URL</p>
                <CopyField id="dev-base" value={apiBase} label="Base URL" />
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-[13px] font-medium text-ink-2">Header</p>
                <CopyField id="dev-auth" value="Authorization: Bearer iaq_…" label="Authorization header" />
              </div>
            </div>
            <p className="text-[13px] leading-relaxed text-muted">
              Endpoints: <span className="font-mono text-[12px]">GET /me</span>, <span className="font-mono text-[12px]">GET|POST /contacts</span>, <span className="font-mono text-[12px]">GET|PATCH /contacts/:id</span>,{" "}
              <span className="font-mono text-[12px]">POST /contacts/:id/tags</span>, <span className="font-mono text-[12px]">GET|POST /opportunities</span>, <span className="font-mono text-[12px]">GET /opportunities/:id</span>,{" "}
              <span className="font-mono text-[12px]">POST /opportunities/:id/stage</span>, <span className="font-mono text-[12px]">GET /pipelines</span>, <span className="font-mono text-[12px]">GET /appointments</span>, <span className="font-mono text-[12px]">GET /tags</span>.
            </p>
            <details className="group rounded-xl border border-line">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[14px] font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-10">
                <ShieldCheck className="size-4 text-muted" aria-hidden />Verifying webhook signatures
              </summary>
              <div className="space-y-2 border-t border-line p-3">
                <p className="text-[13px] leading-relaxed text-muted">
                  Every delivery is a POST with an <span className="font-mono">iAcquire-Signature: t=…,v1=…</span> header: an HMAC-SHA256 of <span className="font-mono">{"<t>.<raw body>"}</span> keyed with the webhook&apos;s signing secret. Check it, refuse old timestamps, answer 2xx within 10 seconds, and ignore an <span className="font-mono">iAcquire-Event-Id</span> you have already processed.
                </p>
                <div className="relative">
                  <pre className="scrollbar-thin overflow-x-auto rounded-lg bg-surface-2 p-3 pr-12 text-[12px] leading-relaxed text-ink"><code>{VERIFY_SNIPPET}</code></pre>
                  <div className="absolute right-2 top-2"><CopyButton value={VERIFY_SNIPPET} label="Copy the verification code" size="icon-sm" variant="ghost" /></div>
                </div>
              </div>
            </details>
          </div>
        </div>
      </Card>

      <ApiKeysSection scope={scope} keys={keys} scopes={scopes} expiryChoices={limits.expiryChoices} maxKeys={limits.maxKeys} canManage={canManage} />
      <WebhooksSection scope={scope} subscriptions={subscriptions} events={events} maxSubscriptions={limits.maxSubscriptions} autoDisableAfter={limits.autoDisableAfter} canManage={canManage} />
    </div>
  );
}
