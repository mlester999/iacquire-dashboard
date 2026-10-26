import type { Metadata } from "next";

// A customer's proposal page: no portal shell, no sign-in. The URL carries the link's private token, so the page is never indexed and never passes its address on as a referrer.
export const metadata: Metadata = {
  title: { default: "Your proposal", template: "%s" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ProposalLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-backdrop min-h-dvh">{children}</div>;
}
