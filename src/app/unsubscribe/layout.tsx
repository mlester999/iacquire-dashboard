import type { Metadata } from "next";

// Public unsubscribe pages: no portal shell, no sign-in. The URL carries a signed link token, so the page is never indexed and never
// passes its address on as a referrer.
export const metadata: Metadata = {
  title: { default: "Unsubscribe", template: "%s" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function UnsubscribeLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-backdrop min-h-dvh">{children}</div>;
}
