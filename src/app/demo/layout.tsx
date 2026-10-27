import type { Metadata } from "next";

// The prospect demo: no portal shell and no sign-in. A prospect is not a user. The emailed link's address carries a credential (the link works once), so none of these pages is
// indexed or passes its address on as a referrer. Each page chooses its own frame: the narrow one for the pages that ask for something (PublicFrame), the full-width showroom for the
// room and the "Why iAcquireOS?" page.
export const metadata: Metadata = {
  title: { default: "iAcquire demo", template: "%s · iAcquire demo" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
