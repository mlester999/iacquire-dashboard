import { SupportFormPage } from "@/components/support/form-page";

export const metadata = { title: "Report an Issue" };

export default async function ReportIssuePage({ searchParams }: { searchParams: Promise<{ from?: string; category?: string; project?: string }> }) {
  return <SupportFormPage kind="issue" searchParams={await searchParams} />;
}
