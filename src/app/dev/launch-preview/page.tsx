import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";
import { LAUNCH_PREVIEW_VIEWS, launchPreview, type LaunchPreviewView } from "./fixtures";

export const dynamic = "force-dynamic";
export const metadata = { title: "Launch readiness design preview" };

/**
 * Development only (404 in production). Renders the launch-readiness panel from clearly labelled sample facts through the real judge, with no network access, so every overall state
 * and layout can be reviewed visually. Nothing here is real, and nothing on this page can change any data: the buttons do nothing.
 */
export default async function LaunchPreview({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  const current: LaunchPreviewView = (LAUNCH_PREVIEW_VIEWS as readonly string[]).includes(view ?? "") ? (view as LaunchPreviewView) : "action";
  return (
    <div className="app-backdrop min-h-dvh">
      <div className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[13px] font-medium text-warning-ink">
        Design preview — sample data for Bright Homes Roofing, not a real client. Actions here do nothing.{" "}
        {LAUNCH_PREVIEW_VIEWS.map((v) => (
          <a key={v} className={v === current ? "mx-1 font-bold underline" : "mx-1 underline"} href={`?view=${v}`}>{v}</a>
        ))}
      </div>
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <LaunchReadinessPanel readiness={launchPreview(current)} preview />
      </main>
    </div>
  );
}
