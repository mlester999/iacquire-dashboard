import { Suspense } from "react";
import { requireAgency } from "@/server/tenancy/context";
import { getOpsOverview } from "@/server/aqi/ops/overview";
import { toPublicError } from "@/server/errors";
import { OpsConsole } from "@/components/aqi/ops/ops-console";
import { OpsOverviewPanel, OpsOverviewSkeleton } from "@/components/aqi/ops/ops-overview";
import type { OpsOverview } from "@/lib/aqi/ops/types";

export const metadata = { title: "AQi Operations" };
export const dynamic = "force-dynamic";

/** The overview streams in so the conversation workspace and shortcuts are usable while the measurements are read. */
async function Overview() {
  let data: OpsOverview | null = null;
  let error: string | null = null;
  try {
    data = await getOpsOverview();
  } catch (err) {
    // A failed read must not look like a healthy platform: say it failed and offer a retry.
    const e = toPublicError(err);
    error = e.code === "internal" ? "The operations overview could not be read right now." : e.message;
  }
  return <OpsOverviewPanel initial={data} initialError={error} />;
}

export default async function AqiOperationsPage() {
  await requireAgency("super_admin");
  return (
    <OpsConsole
      overview={
        <Suspense fallback={<section aria-label="Operations overview"><OpsOverviewSkeleton /></section>}>
          <Overview />
        </Suspense>
      }
    />
  );
}
