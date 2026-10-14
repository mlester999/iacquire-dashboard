import { notFound } from "next/navigation";
import { IntegrationsManager } from "@/components/admin/integrations-manager";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { INTEGRATION_PROVIDERS, INTEGRATION_NAMES, type IntegrationView } from "@/lib/integrations";

export const dynamic = "force-dynamic";

// Labelled sample values so the later wizard steps can be reviewed visually. They are not results
// of any real request, and the sample connections stay at "Credentials saved", never "Connected".
const SAMPLE: Record<string, Record<string, unknown>> = {
  hermes: { identityVerified: true, profile: "client-sample-sales", installedContractVerified: true, supportsRuns: true, supportsEvents: true, supportsStop: true, supportsApproval: true, restrictedTools: [] },
  ghl: {
    locationIdentityVerified: true,
    locationId: "sampleLocation12345",
    provenReadPermissions: ["locations.readonly", "opportunities.readonly", "calendars.readonly"],
    unavailablePermissions: [],
    inventory: {
      pipelines: [{ id: "samplePipeline123", name: "Sample sales pipeline", stages: [] }],
      calendars: [{ id: "sampleCalendar1234", name: "Sample consultation calendar" }, { id: "sampleCalendar5678", name: "Sample follow-up calendar" }],
    },
  },
  n8n: {
    workflows: [
      { id: "sampleWorkflow1", name: "Sample reminder workflow", active: false },
      { id: "sampleWorkflow2", name: "Sample Appointment Event Processor (iAcquire)", active: false },
    ],
    approvedWorkflows: [{ id: "sampleWorkflow1", name: "Sample reminder workflow", active: false }],
    executions: { sampleWorkflow1: [{ id: "e1", status: "success" }, { id: "e2", status: "error" }, { id: "e3", status: "success" }] },
    executionReadVerified: true,
    inventoryTruncated: false,
  },
};

export default async function IntegrationPreview({ searchParams }: { searchParams: Promise<{ scope?: string; sample?: string; step?: string; connect?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { scope, sample, step, connect } = await searchParams;
  const client = scope === "client";
  const withSample = sample === "1";
  const connections: IntegrationView[] = INTEGRATION_PROVIDERS.map((provider) => {
    const data = withSample ? SAMPLE[provider] : undefined;
    return {
      id: data ? `sample-${provider}` : null,
      provider,
      label: INTEGRATION_NAMES[provider],
      status: data ? "credentials_saved" : "not_configured",
      environment: "development",
      config: data && provider === "hermes" ? { baseUrl: "https://gateway.sample.test", profile: "client-sample-sales" } : data && provider === "ghl" ? { locationId: "sampleLocation12345" } : data && provider === "n8n" ? { baseUrl: "https://n8n.sample.test" } : {},
      capabilities: data ?? {},
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      fingerprint: null,
      rotatedAt: null,
      hasCredential: !!data,
      checks: [],
    };
  });
  return (
    <main className="app-backdrop min-h-dvh p-4 sm:p-8">
      <div className="mx-auto max-w-[1200px]">
        <p className="mb-5 rounded-xl bg-warning-soft p-3 text-xs text-warning-ink">
          Development UI preview · {withSample ? "Labelled SAMPLE capability data (not a result of any real request); connections stay at Credentials saved." : "Sample unconfigured cards."} No live connection, saved credential or external action is simulated.
          {" "}Variants: <a className="underline" href="/dev/integrations-preview">global</a> · <a className="underline" href="/dev/integrations-preview?scope=client">client</a> · <a className="underline" href="/dev/integrations-preview?scope=client&sample=1">client + sample data</a>
        </p>
        <div className="mb-4"><PreviewTheme/></div>
        <IntegrationsManager
          initial={{ connections, secureStoreReady: withSample, agencyWorkflows: [], mappedWorkflowIds: [] }}
          orgId={client ? "00000000-0000-4000-8000-000000000001" : null}
          companyName={client ? "Sample Client (preview)" : undefined}
          superAdmin
          timeZone="Asia/Singapore"
          preview
          autoConnect={connect === "hermes" || connect === "ghl" || connect === "n8n" ? connect : undefined}
          previewStep={Number.isInteger(Number(step)) ? Number(step) : 0}
        />
      </div>
    </main>
  );
}
