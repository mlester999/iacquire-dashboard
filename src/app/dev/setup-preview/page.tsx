import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { SetupCenter } from "@/components/setup/setup-center";
import { SetupManager } from "@/components/admin/setup/manager";
import { agencyFixture, clientFixture } from "./fixtures";

export const dynamic = "force-dynamic";
export const metadata = { title: "Setup design preview" };

/**
 * Development only (404 in production). Renders the client and agency setup screens from clearly
 * labelled sample data with no network access, so every task status and layout can be reviewed
 * visually. Nothing here is real, and nothing on this page can change any data.
 */
export default async function SetupPreview({ searchParams }: { searchParams: Promise<{ view?: string; issue?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { view, issue } = await searchParams;
  const admin = view === "admin";
  return (
    <div className="app-backdrop min-h-dvh">
      <div className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[13px] font-medium text-warning-ink">
        Design preview — sample data for Bright Homes Realty, not a real client. Actions here do nothing.{" "}
        <a className="underline" href={`?view=${admin ? "client" : "admin"}`}>
          Switch to the {admin ? "client" : "agency"} view
        </a>
      </div>
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        {admin ? (
          <SetupManager initial={agencyFixture()} orgId="00000000-0000-4000-8000-000000000900" timeZone="America/New_York" viewerIsSuper preview />
        ) : (
          <SetupCenter initial={clientFixture({ checkIssue: issue === "1" })} firstName="Jordan" timeZone="America/New_York" preview />
        )}
      </main>
    </div>
  );
}
