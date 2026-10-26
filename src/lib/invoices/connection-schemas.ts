import { z } from "zod";
import { CURRENT_AUTHORIZATION_VERSION, PAYPAL_ENVIRONMENTS } from "@/lib/invoices/connection-rules";

// What the owner types when connecting, replacing keys or confirming. The server checks the same things again; a key is never echoed back in an error.

const authorization = z.object({
  accepted: z.literal(true, { error: "Read the authorization and tick the box to continue." }),
  version: z.string().max(40).refine((v) => v === CURRENT_AUTHORIZATION_VERSION, { error: "The authorization wording changed. Read the current wording and accept it again." }),
});

export const connectSchema = z.object({
  provider: z.enum(["paymongo", "paypal", "simulated"], { error: "Choose a payment provider." }),
  /** PayMongo: the secret key (sk_test_… or sk_live_…). PayPal: the app's client ID. Not used by the simulated provider, which makes its own. */
  apiKey: z.string().max(300).optional(),
  /** PayPal only: the app's client secret. */
  apiSecret: z.string().max(300).optional(),
  /** PayPal only: whether the app is a sandbox (testing) one or a live one. Nothing in the keys says. */
  environment: z.enum(PAYPAL_ENVIRONMENTS).optional(),
  /** The signing secret of the webhook the owner created at the provider for this connection's address (PayPal: that webhook's ID). Can be added afterwards. */
  webhookSecret: z.string().max(300).nullish(),
  accountLabel: z.string().max(120).nullish(),
  authorization,
});
export type ConnectInput = z.infer<typeof connectSchema>;

export const replaceCredentialsSchema = z.object({
  apiKey: z.string().min(1, { error: "Paste the secret key." }).max(300),
  apiSecret: z.string().max(300).optional(),
  environment: z.enum(PAYPAL_ENVIRONMENTS).optional(),
  webhookSecret: z.string().max(300).nullish(),
  authorization,
});
export type ReplaceCredentialsInput = z.infer<typeof replaceCredentialsSchema>;

export const webhookSecretSchema = z.object({ webhookSecret: z.string().min(1, { error: "Paste the webhook signing secret." }).max(300) });
