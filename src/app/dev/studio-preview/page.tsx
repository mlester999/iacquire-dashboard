import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { ALL_TEMPLATE_KEYS } from "@/lib/website/templates";
import PreviewClient from "./preview-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website editor preview" };

/**
 * Development only (404 in production). Runs the real website editor against an in-memory stand-in for the server,
 * with clearly labelled sample data. ?role=editor shows the "send for approval" path; ?template=family.style picks the style.
 */
export default async function StudioPreview({ searchParams }: { searchParams: Promise<{ role?: string; template?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { role, template } = await searchParams;
  return <PreviewClient role={role === "editor" ? "editor" : "owner"} template={template && ALL_TEMPLATE_KEYS.includes(template) ? template : "summit.peak"} />;
}
