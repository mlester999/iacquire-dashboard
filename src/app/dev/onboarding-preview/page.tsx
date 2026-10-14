import { notFound } from "next/navigation";
import { env } from "@/server/env";
import PreviewClient from "./preview-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Onboarding design preview" };

/**
 * Development only (404 in production). Runs the real questionnaire interface against an in-memory
 * stand-in for the server, using clearly labelled sample data. Nothing here is saved anywhere real.
 */
export default async function OnboardingPreview({ searchParams }: { searchParams: Promise<{ seed?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { seed } = await searchParams;
  return <PreviewClient seed={seed === "full" ? "full" : "empty"} />;
}
