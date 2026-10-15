"use client";

import dynamic from "next/dynamic";
import type { SiteContent } from "@/lib/website/doc";

const Inner = dynamic(() => import("./preview-inner"), { ssr: false, loading: () => <p className="p-8 text-center text-sm text-muted">Loading the editor…</p> });

export default function PreviewClient(props: { role: "owner" | "editor" | "agency"; templateKey: string; content: SiteContent }) {
  return <Inner {...props} />;
}
