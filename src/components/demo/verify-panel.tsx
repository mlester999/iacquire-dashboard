import * as React from "react";
import Link from "next/link";
import { Hourglass, Link2Off, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DemoMessage, DemoNotice, linkClass } from "@/components/demo/shell";
import type { Notice } from "@/lib/demo/outcomes";
import type { PeekResult } from "@/server/demo/public";

// The page an emailed link opens. Opening it only READS: it changes nothing, so a mail scanner that follows every link cannot use the link up. The person presses the button, which
// posts the link's token (in the body, never in an address) to the demo API; that is what starts the demo.

export function VerifyPanel({ token, peek, notice, linkUnused }: { token: string; peek: PeekResult | null; notice: Notice | null; linkUnused: boolean }) {
  // A post that failed sends the person back here without the link; the notice says why and where to go. When the refusal left the link unused, the email's link still works.
  if (!peek) {
    return (
      <DemoMessage icon={Link2Off} title="That did not work">
        <DemoNotice notice={notice} />
        {linkUnused && <p>Your link has not been used up. Open it from your email again to try once more.</p>}
        <p>
          <Link href="/demo" className={linkClass}>
            Ask for a new link
          </Link>
        </p>
      </DemoMessage>
    );
  }
  if (!peek.ok) {
    return (
      <DemoMessage icon={peek.reason === "rate_limited" ? Hourglass : Link2Off} title="This link cannot be used">
        <p>{peek.message}</p>
        <p>
          <Link href="/demo" className={linkClass}>
            Back to the demo page
          </Link>
        </p>
      </DemoMessage>
    );
  }
  const returning = peek.purpose === "return";
  return (
    <DemoMessage icon={MailCheck} title={returning ? "Welcome back" : "Open your demo"}>
      <p>
        {returning
          ? "Press the button to go back to your demo. Your conversation and your remaining messages are kept."
          : "Press the button to confirm your email address and open your demo. Your demo window starts when you press it."}
      </p>
      <form method="post" action="/api/public/demo/verify" className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <Button type="submit" size="lg" className="w-full">
          {returning ? "Continue my demo" : "Open my demo"}
        </Button>
      </form>
      <p className="text-[13px]">This link works once. If you did not ask for a demo, you can close this page.</p>
    </DemoMessage>
  );
}
