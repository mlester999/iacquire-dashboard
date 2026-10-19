import { SupportFormPage } from "@/components/support/form-page";

export const metadata = { title: "Get Support" };

export default async function SupportPage({ searchParams }: { searchParams: Promise<{ from?: string; category?: string }> }) {
  return <SupportFormPage kind="support" searchParams={await searchParams} />;
}
