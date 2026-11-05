"use client";

import { useActionState, type ReactNode } from "react";
import { Globe, Info, MapPin, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, Input, SectionHeading, Textarea } from "@/components/ui/primitives";
import { saveResearchSourcePolicyAction, type ResearchSourcePolicyActionState } from "@/app/actions/leads";

export type ResearchSourcePolicyView = {
  enabled: boolean;
  providerFeeUsdPerRequest: number;
  perJobRequestCap: number;
  perDayRequestCap: number;
  perJobSpendCapUsd: number;
  perDaySpendCapUsd: number;
  sourceConfig: Record<string, unknown>;
};

export type ResearchSourcePoliciesView = {
  openstreetmap: ResearchSourcePolicyView | null;
  company_website: ResearchSourcePolicyView | null;
};

type SourceKey = keyof ResearchSourcePoliciesView;

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

function SourcePolicyCard({ source, policy }: { source: SourceKey; policy: ResearchSourcePolicyView | null }) {
  const [state, formAction, pending] = useActionState(saveResearchSourcePolicyAction, initialActionState);
  const isOpenStreetMap = source === "openstreetmap";
  const title = isOpenStreetMap ? "OpenStreetMap discovery" : "Company websites";
  const description = isOpenStreetMap
    ? "Find local businesses within an approved area using read-only map requests."
    : "Review only the exact company domains you approve. No customer contact is sent.";
  const Icon = isOpenStreetMap ? MapPin : Globe;
  const config = policy?.sourceConfig ?? {};
  const bounds = configRecord(config.bounds);

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
                <Badge tone={policy?.enabled ? "success" : "neutral"}>{policy?.enabled ? "Enabled" : "Disabled"}</Badge>
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
                <Input name="perJobRequestCap" type="number" min="0" max="10000" step="1" required defaultValue={policy?.perJobRequestCap ?? 0} />
              </SourceField>
              <SourceField label="Maximum requests per day">
                <Input name="perDayRequestCap" type="number" min="0" max="100000" step="1" required defaultValue={policy?.perDayRequestCap ?? 0} />
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

export function ResearchSourceSettings({ policies }: { policies: ResearchSourcePoliciesView }) {
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
        <SourcePolicyCard source="openstreetmap" policy={policies.openstreetmap} />
        <SourcePolicyCard source="company_website" policy={policies.company_website} />
      </div>
    </section>
  );
}
