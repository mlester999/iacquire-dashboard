import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { RuntimeControls } from "@/components/admin/runtime-controls";
import { RUNTIME_CONTROLS_PREVIEW_VIEWS, runtimeControlsPreview, type RuntimeControlsPreviewView } from "./fixtures";

export const dynamic = "force-dynamic";
export const metadata = { title: "Runtime controls design preview" };

/**
 * Development only (404 in production). Renders the agency's runtime controls from clearly labelled sample data so each state and layout can be reviewed visually. The workspace is not
 * real, so any press on a control is refused by the server (it also needs a Super Admin session); nothing on this page can change any data.
 */
export default async function RuntimeControlsPreview({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  const current: RuntimeControlsPreviewView = (RUNTIME_CONTROLS_PREVIEW_VIEWS as readonly string[]).includes(view ?? "") ? (view as RuntimeControlsPreviewView) : "defaults";
  return (
    <div className="app-backdrop min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[13px] font-medium text-warning-ink">
        Design preview: sample data for Bright Homes Roofing, not a real client. The server refuses every action here.{" "}
        {RUNTIME_CONTROLS_PREVIEW_VIEWS.map((v) => (
          <a key={v} className={v === current ? "mx-1 font-bold underline" : "mx-1 underline"} href={`?view=${v}`}>{v}</a>
        ))}
      </header>
      <main className="mx-auto w-full max-w-[960px] px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="sr-only">Runtime controls design preview</h1>
        <RuntimeControls data={runtimeControlsPreview(current)} />
        {current === "none" ? <p className="text-[13px] text-muted">The component renders nothing for this view, as it does for anyone who is not a Super Admin looking at a real client workspace.</p> : null}
      </main>
    </div>
  );
}
