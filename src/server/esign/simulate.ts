import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import type { RequestStatus } from "@/lib/esign/state";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { loadConnection, loadRequest } from "@/server/esign/core";
import { openCredentials } from "@/server/esign/credentials";
import { simulatedAllowed } from "@/server/esign/providers";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { runEsignSync } from "@/server/esign/maintenance";
import { hashWebhookToken, tokenForStoredConnection } from "@/server/esign/webhook-token";
import { handleEsignWebhook } from "@/server/esign/webhook";

// For tests and browser QA only: lets a person play the signer at the SIMULATED signing service, so the whole pipeline can be clicked through without an account anywhere. It does
// not skip anything real: the stand-in service changes its own document, and what iAcquire learns comes through the same signed webhook route a real service uses, with the
// connection's own key. It exists only where the simulated service does (never in production), only for a request made through a simulated connection, and it never touches a
// real one. Nothing it produces is a signature of any kind: the request, the proposal's history and the pages all say "simulated".

export type SimulatedSignerAction = "send_now" | "view" | "sign" | "decline" | "expire";

const SIGNER = { view: "view", sign: "complete", decline: "decline", expire: "expire" } as const;

export async function actAsSimulatedSigner(actor: CrmActor, requestId: string, action: SimulatedSignerAction, deps: { now?: Date } = {}): Promise<{ status: RequestStatus; note: string }> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  if (!simulatedAllowed()) throw new AppError("forbidden", "The simulated signing service is not available in production.");
  if (action !== "send_now" && !Object.hasOwn(SIGNER, action)) throw new AppError("invalid_input", "That is not something the simulated signer can do.");
  const req = await crmRead(actor, (db) => loadRequest(db, actor.orgId, requestId));
  if (!req) throw new AppError("not_found", "That signing request was not found.");
  if (req.mode !== "simulated" || req.provider !== "simulated") throw new AppError("conflict", "Only a request made through the simulated signing service can be acted for here.");

  // Hand over what is due (the stand-in service is asked in this process, so this is the moment it "sends").
  if (action === "send_now") {
    await runEsignSync({ orgId: actor.orgId, now: deps.now ? () => deps.now as Date : undefined });
    const after = await crmRead(actor, (db) => loadRequest(db, actor.orgId, requestId));
    return { status: after?.status ?? req.status, note: "The simulated service was asked to send it." };
  }

  const documentId = req.provider_document_id;
  if (!documentId) throw new AppError("conflict", "The request has not reached the simulated service yet. Use \"Hand it over now\" first.");
  const connection = await withSystem((db) => loadConnection(db, actor.orgId, req.connection_id));
  const creds = connection ? openCredentials(connection.credentials) : null;
  const token = connection ? tokenForStoredConnection(connection.id, connection.webhook_token_hash) : null;
  if (!connection || !creds || !token || hashWebhookToken(token) !== connection.webhook_token_hash) throw new AppError("conflict", "The simulated connection can no longer be used. Connect it again.");
  const now = deps.now ?? new Date();
  try {
    simulatedEsign.signerAction(documentId, SIGNER[action]);
  } catch {
    throw new AppError("conflict", "The simulated service no longer has this document (it forgets everything when the server restarts).");
  }
  // The delivery is signed with the connection's key and posted to the same handler the real route calls.
  const delivery = simulatedEsign.delivery(documentId, creds.webhookKey, { at: now });
  const answered = await handleEsignWebhook({ token, rawBody: delivery.rawBody, headers: delivery.headers, query: delivery.query, ip: null, now });
  if (answered.status !== 200) throw new AppError("conflict", `The notice was not accepted (${answered.body.reason ?? answered.status}).`);
  // A signed copy is fetched by the scheduler; here it is done at once so the page shows it.
  if (action === "sign") await runEsignSync({ orgId: actor.orgId, now: deps.now ? () => deps.now as Date : undefined }).catch(() => undefined);
  const after = await crmRead(actor, (db) => loadRequest(db, actor.orgId, requestId));
  return { status: after?.status ?? req.status, note: "Done at the simulated service. Nothing real was signed." };
}
