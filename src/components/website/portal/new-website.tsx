"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createWebsiteAction } from "@/app/actions/website";
import { TemplatePicker } from "@/components/website/studio/template-picker";
import type { SiteDetails } from "@/lib/website/generate";

/** Choosing a style creates the private draft, written from the business details already given. Nothing is published. */
export function NewWebsite({ details, industry }: { details: SiteDetails; industry: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const choose = async (key: string) => {
    setBusy(true);
    const res = await createWebsiteAction(key);
    if (!res.ok) {
      setBusy(false);
      return void toast.error(res.error);
    }
    router.push("/website/edit");
  };
  return <TemplatePicker details={details} industry={industry} busy={busy} onChoose={(k) => void choose(k)} chooseLabel="Build my site in this style" />;
}
