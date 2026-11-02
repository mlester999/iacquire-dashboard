import type { Metadata } from "next";
import { headers } from "next/headers";
import { PublicPurchaseBody, PublicPurchaseInvalid, PublicPurchaseShell, PublicPurchaseTooMany } from "@/components/purchase-intents/public-purchase";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { getPublicPurchase } from "@/server/purchase-intents/service";

export const metadata: Metadata = { title: "Your iAcquireOS purchase", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function ip(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

export default async function PublicPurchasePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const limited = await consumeRateLimit(RATE_LIMITS.purchaseIntentViewByIp, (await ip()) ?? "unknown");
  if (!limited.allowed) return <PublicPurchaseShell><PublicPurchaseTooMany /></PublicPurchaseShell>;
  const purchase = await getPublicPurchase(token);
  if (!purchase) return <PublicPurchaseShell><PublicPurchaseInvalid /></PublicPurchaseShell>;
  return <PublicPurchaseShell><PublicPurchaseBody purchase={purchase} token={token} /></PublicPurchaseShell>;
}
