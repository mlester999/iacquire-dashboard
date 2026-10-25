import Link from "next/link";
import { Share2 } from "lucide-react";

/** The heading, and the first sentence of the refusal the server gives for the same reason (SOCIAL_CLIENT_ONLY_MESSAGE in src/lib/social/workspace.ts). */
export const SOCIAL_CLIENT_ONLY_TITLE = "Social media is managed inside each client's workspace";

/** What the social media area shows in an agency workspace: where it lives instead. Nothing here queries or changes anything. */
export function SocialClientOnlyNotice({ canOpenClients }: { canOpenClients: boolean }) {
  return (
    <section aria-labelledby="social-client-only" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <h1 id="social-client-only" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-ink"><Share2 className="size-5 text-muted" aria-hidden />{SOCIAL_CLIENT_ONLY_TITLE}</h1>
      <p className="max-w-2xl text-[14px] text-ink-2">The Facebook Pages and Instagram accounts belong to the business that owns them, and that business&apos;s own team approves every post before it goes out. An agency workspace never approves what a client publishes, so it has no accounts, calendar or approvals of its own.</p>
      <p className="max-w-2xl text-[14px] text-ink-2">To see or work on a client&apos;s social media, open that client&apos;s workspace.</p>
      {canOpenClients && <Link href="/admin/clients" className="inline-flex min-h-11 items-center rounded-xl brand-gradient px-4 text-[14px] font-medium text-white sm:min-h-10">Go to clients</Link>}
    </section>
  );
}
