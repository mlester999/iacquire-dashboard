// Fixtures for the signing screens' tests: a complete ProposalDetail with a Signature tab, and requests in every state. Nothing here touches a database or a provider.
import { computeDocTotals } from "@/lib/proposals/money";
import type { ProposalDoc } from "@/lib/proposals/doc";
import type { ConnectionView } from "@/server/esign/connections";
import type { RequestView } from "@/server/esign/requests";
import type { ProposalDetail } from "@/server/proposals/view";

export const ME = "11111111-1111-4111-8111-111111111111";
export const PID = "55555555-5555-4555-8555-555555555555";
export const REQ = "77777777-7777-4777-8777-777777777777";
export const FILE_SIGNED = "88888888-8888-4888-8888-888888888888";
export const FILE_CERT = "99999999-9999-4999-8999-999999999999";

const doc = (): ProposalDoc => ({
  v: 1,
  sections: [{ id: "sec-intro01", heading: "Introduction", body: "Thank you for your time." }],
  lines: [{
    id: "line-book01", catalogItemId: "22222222-2222-4222-8222-222222222222", name: "Website build", description: "", unitLabel: "project", quantityMilli: 1000, unitPriceMinor: 150_000, catalogPriceMinor: 150_000,
    billing: "one_time", taxRateId: "44444444-4444-4444-8444-444444444444", taxName: "Sales tax", taxBps: 1200, discount: null, note: "",
  }],
  terms: "Payment is due within 14 days.",
});

export const connection = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", provider: "simulated", providerLabel: "the simulated signing service", mode: "simulated", label: "", accountLabel: "Simulated signing service", status: "connected", statusDetail: null,
  lastCheckedAt: "2026-10-23T10:00:00.000Z", lastSuccessAt: "2026-10-23T10:00:00.000Z", connectedAt: "2026-10-22T10:00:00.000Z",
  notice: "Simulated: no real document is sent and nothing here is legally binding.", usable: true, ...over,
});

export const request = (over: Partial<RequestView> = {}): RequestView => ({
  id: REQ, proposalVersion: 1, current: true, status: "sent", statusLabel: "Sent for signing", explain: "PandaDoc has been asked to send the document to Maria Santos. Nothing is signed yet.", signerName: "Maria Santos",
  signerEmail: "maria@example.test", provider: "pandadoc", providerLabel: "PandaDoc", mode: "sandbox", createdAt: "2026-10-23T09:00:00.000Z", sentAt: "2026-10-23T09:01:00.000Z", completedAt: null, applied: false,
  notAppliedReason: null, notAppliedText: null, signedFileId: null, certificateFileId: null, copyPending: false, copyGaveUp: false, lastError: null, voidReason: null, cancelNote: null, canVoid: true,
  events: [
    { id: 2, at: "2026-10-23T09:01:00.000Z", kind: "sent", source: "system", detail: { from: "sending" } },
    { id: 1, at: "2026-10-23T09:00:00.000Z", kind: "created", source: "user", detail: {} },
  ], ...over,
});

export function signature(over: Partial<ProposalDetail["signature"]> = {}): ProposalDetail["signature"] {
  return {
    enabled: true, connection: connection(), requests: [], blocked: null, canRequest: true, canConnect: false, defaultSigner: { name: "Maria Santos", email: "maria@example.test" }, simulated: true, ...over,
  };
}

export function detailFixture(over: Partial<ProposalDetail> = {}): ProposalDetail {
  const d = over.doc ?? doc();
  return {
    id: PID, number: "P-0001", title: "Website proposal", status: "sent", origin: "human", clientName: "Maria Santos", clientCompany: "Santos Dental", currency: "USD",
    totals: { one_time: 168_000, monthly: 0, yearly: 0 }, validUntil: "2026-11-30", ownerId: ME, ownerName: "Alex Rivera", version: 1, requiresSignature: true, contactId: null, companyId: null,
    opportunityId: null, sentAt: "2026-10-22T10:00:00.000Z", closedAt: null, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z", doc: d, liveTotals: computeDocTotals(d.lines).groups,
    clientEmail: "maria@example.test", internalNotes: null, templateId: null, templateVersion: null, approvedVersion: 1, approvedByName: "Sam Lee", approvedAt: "2026-10-21T10:00:00.000Z", decisionNote: null,
    sentVersion: 1, sentByName: "Alex Rivera", signatureState: "none", problems: [], approval: { required: false, reasons: [] }, versions: [], decisions: [], events: [], share: null, deliveries: [], preview: null,
    createdById: ME, viewer: { userId: ME, canEdit: false, isAuthor: true }, ai: null, signature: signature(), ...over,
  };
}
