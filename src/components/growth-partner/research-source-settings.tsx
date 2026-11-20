"use client";

import { useActionState, type ReactNode } from "react";
import { Globe, Info, MapPin, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Input, SectionHeading, Textarea } from "@/components/ui/primitives";
import { saveResearchSourcePolicyAction, type ResearchSourcePolicyActionState } from "@/app/actions/leads";
import { formatDateTime } from "@/lib/utils";
import { FSA_DIRECTORY_LICENCE, FSA_DIRECTORY_NAME, type ResearchSourceKey } from "@/lib/lead-research-sources";
import type { ResearchSourceHealth } from "@/server/leads/research-source-policy";

export type ResearchSourcePolicyView = {
  enabled: boolean;
  providerFeeUsdPerRequest: number;
  perJobRequestCap: number;
  perDayRequestCap: number;
  perJobSpendCapUsd: number;
  perDaySpendCapUsd: number;
  sourceConfig: Record<string, unknown>;
  health?: ResearchSourceHealth | null;
  approvalCurrent?: boolean;
};

export type ResearchSourcePoliciesView = {
  openstreetmap: ResearchSourcePolicyView | null;
  company_website: ResearchSourcePolicyView | null;
  fsa_directory?: ResearchSourcePolicyView | null;
};

const initialActionState: ResearchSourcePolicyActionState = { status: "idle", message: "" };

function configRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configText(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function configLines(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
}

function configFieldNumber(config: Record<string, unknown>, key: string): number | "" {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function SourceField({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 text-[13px] font-medium text-ink-2 ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function SourceHealthSummary({ health, timeZone }: { health?: ResearchSourceHealth | null; timeZone: string }) {
  const style = "rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-muted";
  if (!health) return <p className={style}>Source history is unavailable.</p>;
  if (!health.lastResponseAt && !health.lastError) {
    return <p className={style}>Waiting for the first recorded result under this approval.</p>;
  }
  const time = (value: string) => <time dateTime={value}>{formatDateTime(value, timeZone)}</time>;
  return (
    <dl className={style}>
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-ink-2">Last successful response</dt>
        <dd>{health.lastResponseAt ? time(health.lastResponseAt) : "None recorded"}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-ink-2">Last completed run with a successful response</dt>
        <dd>{health.lastCompletedRunAt ? time(health.lastCompletedRunAt) : "None recorded"}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-ink-2">Last request error</dt>
        <dd>{health.lastError ? <>{health.lastError.invalidResponse ? "Invalid provider response" : health.lastError.httpStatus ? `HTTP ${health.lastError.httpStatus}` : "Transport failure"} · {time(health.lastError.at)}</> : "None recorded"}</dd>
      </div>
    </dl>
  );
}

function SourcePolicyCard({ source, policy, timeZone, workspaceId }: {
  source: ResearchSourceKey; policy: ResearchSourcePolicyView | null; timeZone: string; workspaceId?: string;
}) {
  const [state, formAction, pending] = useActionState(saveResearchSourcePolicyAction, initialActionState);
  const isOpenStreetMap = source === "openstreetmap";
  const isDirectory = source === "fsa_directory";
  const title = isOpenStreetMap ? "OpenStreetMap discovery" : isDirectory ? FSA_DIRECTORY_NAME : "Company websites";
  const description = isOpenStreetMap
    ? "Find local businesses within an approved area using read-only map requests."
    : isDirectory ? "Find restaurants, cafés and canteens in one approved UK local authority. Listings are a starting point for human review."
      : "Review only the exact company domains you approve. No customer contact is sent.";
  const Icon = isOpenStreetMap ? MapPin : Globe;
  const config = policy?.sourceConfig ?? {};
  const bounds = configRecord(config.bounds);
  const approved = policy?.enabled && policy.approvalCurrent !== false;

  return (
    <Card className="border border-line bg-surface shadow-soft">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <form action={formAction} aria-label={`Configure ${title}`} className="space-y-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink">
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
                <Badge tone={approved ? "success" : "neutral"}>{approved ? "Enabled" : policy?.enabled ? "Needs approval" : "Disabled"}</Badge>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[12px] font-medium text-ink-2">
              <input
                type="checkbox"
                role="switch"
                name="enabled"
                value="true"
                aria-label={`Allow ${title} requests`}
                defaultChecked={policy?.enabled ?? false}
                className="size-4 accent-primary"
              />
              Allow requests
            </label>
          </div>

          {approved && <SourceHealthSummary health={policy.health} timeZone={timeZone} />}

          <input type="hidden" name="source" value={source} />

          {isOpenStreetMap ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <SourceField label="Provider fee per request (USD)">
                  <Input name="providerFeeUsdPerRequest" type="number" min="0" max="1000000" step="0.01" required defaultValue={policy?.providerFeeUsdPerRequest ?? ""} placeholder="Enter the reviewed fee" />
                </SourceField>
                <SourceField label="Exact allowed server host">
                  <Input name="approvedEndpointHosts" required defaultValue={configLines(config, "approvedEndpointHosts")} placeholder="Enter the approved host" />
                </SourceField>
              </div>
              <p className="text-[12px] leading-relaxed text-muted">Only the exact approved HTTPS host is used. The endpoint and area are set under advanced details.</p>
            </div>
          ) : isDirectory ? (
            <div className="space-y-3">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <SourceField label="FSA local authority ID"><Input name="authorityId" type="number" min="1" max="9999" step="1" required defaultValue={configFieldNumber(config, "authorityId")} /></SourceField>
                <SourceField label="FSA local authority code"><Input name="authorityCode" required maxLength={12} defaultValue={configText(config, "authorityCode")} /></SourceField>
                <SourceField label="FSA local authority name"><Input name="authorityName" required maxLength={100} defaultValue={configText(config, "authorityName")} /></SourceField>
                <SourceField label="Business name keyword (optional)"><Input name="nameKeyword" maxLength={40} defaultValue={configText(config, "nameKeyword")} /></SourceField>
                <SourceField label="Maximum results per request"><Input name="maxResults" type="number" min="1" max="20" step="1" required defaultValue={configNumber(config, "maxResults", 10)} /></SourceField>
                <SourceField label="Approval expires at midnight UTC"><Input name="approvalExpiresOn" type="date" required defaultValue={configText(config, "approvalExpiresOn")} /></SourceField>
              </div>
              <p className="text-[12px] leading-relaxed text-muted">Provider fee is $0.00 per request. Approval can last up to 30 days. Review the <a className="font-semibold text-primary underline" href="https://ratings.food.gov.uk/terms-and-conditions" target="_blank" rel="noreferrer">FSA terms</a> and the <a className="font-semibold text-primary underline" href={FSA_DIRECTORY_LICENCE} target="_blank" rel="noreferrer">Open Government Licence</a>.</p>
              <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-ink-2">
                <input type="checkbox" name="rightsAcknowledged" value="true" className="mt-0.5 size-4 shrink-0 accent-primary" />
                <span>I have reviewed the terms and confirmed this workspace may use these public business listings for prospect review.</span>
              </label>
            </div>
          ) : (
            <div className="space-y-3">
              <SourceField label="Approved company domains">
                <Textarea name="approvedDomains" rows={2} required defaultValue={configLines(config, "approvedDomains")} placeholder="Add one exact domain per line" className="min-h-[76px] text-sm" />
              </SourceField>
              <div className="grid gap-3 sm:grid-cols-2">
                <SourceField label="Provider fee per request (USD)">
                  <Input type="text" value="$0.00" readOnly aria-label="Company website provider fee is zero dollars per request" />
                </SourceField>
                <input type="hidden" name="providerFeeUsdPerRequest" value="0" />
                <SourceField label="Maximum pages per company">
                  <Input name="maxRequests" type="number" min="1" max="20" step="1" required defaultValue={configNumber(config, "maxRequests", 8)} />
                </SourceField>
              </div>
            </div>
          )}

          <fieldset className="space-y-2.5">
            <legend className="text-[12px] font-semibold text-ink-2">Request limits</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <SourceField label="Maximum requests per job">
                <Input name="perJobRequestCap" type="number" min="0" max={isDirectory ? 1 : 10000} step="1" required defaultValue={policy?.perJobRequestCap ?? 0} />
              </SourceField>
              <SourceField label="Maximum requests per day">
                <Input name="perDayRequestCap" type="number" min="0" max={isDirectory ? 12 : 100000} step="1" required defaultValue={policy?.perDayRequestCap ?? 0} />
              </SourceField>
              <SourceField label="Provider spend cap per job (USD)">
                <Input name="perJobSpendCapUsd" type="number" min="0" max="1000000" step="0.01" required defaultValue={policy?.perJobSpendCapUsd ?? 0} />
              </SourceField>
              <SourceField label="Provider spend cap per day (USD)">
                <Input name="perDaySpendCapUsd" type="number" min="0" max="1000000" step="0.01" required defaultValue={policy?.perDaySpendCapUsd ?? 0} />
              </SourceField>
            </div>
          </fieldset>

          {isOpenStreetMap ? (
            <details className="rounded-xl border border-line bg-surface-2/50 px-3.5">
              <summary className="cursor-pointer py-3 text-[13px] font-semibold text-ink-2">Advanced source details</summary>
              <div className="space-y-3 border-t border-line py-3">
                <SourceField label="Reviewed HTTPS endpoint">
                  <Input name="endpoint" type="url" required defaultValue={configText(config, "endpoint")} placeholder="Enter an approved endpoint" />
                </SourceField>
                <SourceField label="Identifying User-Agent">
                  <Input name="userAgent" required defaultValue={configText(config, "userAgent")} placeholder="Enter an identifying User-Agent" />
                </SourceField>
                <fieldset className="space-y-2">
                  <legend className="text-[12px] font-medium text-ink-2">Bounded area coordinates</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SourceField label="South latitude"><Input name="boundsSouth" type="number" step="any" required defaultValue={configFieldNumber(bounds, "south")} placeholder="Latitude" /></SourceField>
                    <SourceField label="West longitude"><Input name="boundsWest" type="number" step="any" required defaultValue={configFieldNumber(bounds, "west")} placeholder="Longitude" /></SourceField>
                    <SourceField label="North latitude"><Input name="boundsNorth" type="number" step="any" required defaultValue={configFieldNumber(bounds, "north")} placeholder="Latitude" /></SourceField>
                    <SourceField label="East longitude"><Input name="boundsEast" type="number" step="any" required defaultValue={configFieldNumber(bounds, "east")} placeholder="Longitude" /></SourceField>
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SourceField label="Maximum results per request"><Input name="maxResults" type="number" min="1" max="50" step="1" required defaultValue={configNumber(config, "maxResults", 25)} /></SourceField>
                  <SourceField label="Request timeout (seconds)"><Input name="timeoutSeconds" type="number" min="1" max="25" step="1" required defaultValue={configNumber(config, "timeoutSeconds", 25)} /></SourceField>
                </div>
              </div>
            </details>
          ) : null}

          <label className="flex items-start gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[12px] leading-relaxed text-ink-2">
            <input type="checkbox" name="activationAcknowledged" value="true" className="mt-0.5 size-4 shrink-0 accent-primary" />
            <span>I approve bounded, read-only requests to this source using the limits above.</span>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <p className="max-w-sm text-[12px] leading-relaxed text-muted">Provider fee caps exclude hosting and data-transfer costs, which are not currently measured. Saving stores limits; it does not start discovery.</p>
            <Button type="submit" variant="secondary" size="sm" loading={pending}>
              <Save className="size-4" aria-hidden />
              Save settings
            </Button>
          </div>
          {state.status === "error" ? <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger-ink">{state.message}</p> : null}
          {state.status === "success" ? <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-[12px] text-success-ink">{state.message}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}

export function ResearchSourceSettings({ policies, timeZone = "UTC", workspaceId }: {
  policies: ResearchSourcePoliciesView; timeZone?: string; workspaceId?: string;
}) {
  return (
    <section aria-label="Research sources" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          title="Research sources"
          description="Choose which read-only sources your AI Growth Partner may use for prospect research."
        />
        <Badge tone="neutral"><ShieldCheck className="size-3.5" aria-hidden /> Owner and admin settings</Badge>
      </div>
      <div role="note" className="flex gap-2.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[12px] leading-relaxed text-muted">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p><span className="font-semibold text-ink-2">About costs.</span> Provider fees are shown separately. Hosting and data-transfer costs are not currently measured and are not included in provider-fee limits.</p>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <SourcePolicyCard source="openstreetmap" policy={policies.openstreetmap} timeZone={timeZone} />
        <SourcePolicyCard source="company_website" policy={policies.company_website} timeZone={timeZone} />
        {workspaceId && <SourcePolicyCard source="fsa_directory" policy={policies.fsa_directory ?? null} timeZone={timeZone} workspaceId={workspaceId} />}
      </div>
    </section>
  );
}
