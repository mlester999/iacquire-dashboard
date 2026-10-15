import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { DEFAULT_TEMPLATE_KEY, resolveTemplate, sampleSite } from "@/lib/website/templates";
import PreviewClient from "./preview-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Website editor preview" };

/**
 * Development only (404 in production). Runs the real website editor against an in-memory stand-in for the server, with the template's own
 * canonical fictional identity and exact starter revision. ?role=owner|editor|agency, ?template=family.variation.
 */
export default async function StudioPreview({ searchParams }: { searchParams: Promise<{ role?: string; template?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { role, template } = await searchParams;
  const t = resolveTemplate(template ?? "") ?? resolveTemplate(DEFAULT_TEMPLATE_KEY)!;
  const content = sampleSite(t.key);
  return <PreviewClient role={role === "editor" ? "editor" : role === "agency" ? "agency" : "owner"} templateKey={t.key} content={JSON.parse(JSON.stringify(content))} />;
}
