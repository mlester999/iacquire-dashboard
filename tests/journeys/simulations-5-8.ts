// Simulation entries for journeys 5-8, which are written in a parallel change to the same suite. They live here so that the two changes never edit the same
// file: ./simulations.ts merges this list into the one registry that tests/journeys/journeys.test.ts reads.
//
// Each entry names one external system a journey would otherwise reach and the existing seam that stands in for it. Every entry is `real: false`: no journey
// test contacts the outside world (tests/support/no-network.ts refuses the socket), so what the suite proves is how the product handles those stand-ins.
import type { Simulation } from "./simulations";

export const SIMULATIONS_5_8: Simulation[] = [
  // Journey 5: a published social post brings an attributed lead.
  {
    journey: 5,
    external: "The social platform a post is published to (a Facebook Page)",
    simulatedBy: "src/server/social/providers/simulated.ts simulatedProvider, driven through src/server/social/publisher.ts and read back with simulated.published (the publisher's own provider seam)",
    real: false,
  },
  {
    journey: 5,
    external: "The visitor's browser that follows the post's tracked link to the client's site",
    simulatedBy: "tests/support/webchat.ts start() + embedCall (the public website-chat handler called in process with the landing address the platform's link carried)",
    real: false,
  },
  // Journey 6: an accepted and signed proposal becomes an invoice and verified revenue.
  {
    journey: 6,
    external: "The e-signature provider the customer signs through",
    simulatedBy: "src/server/esign/providers/simulated.ts simulatedProvider, wired by tests/support/proposals.ts signingOrg, handedOver and signerActs",
    real: false,
  },
  {
    journey: 6,
    external: "The payment provider (PayMongo: the hosted checkout, and the signed 'checkout paid' webhook)",
    simulatedBy: "tests/support/customer-payments.ts connect + attempt + deliver + paymongoPaid (a hand-written body signed with the connection's made-up webhook secret, handed to the real webhook handler), with fetch replaced so an accidental call fails",
    real: false,
  },
  {
    journey: 6,
    external: "The email provider that would send the proposal to the customer (and, in the public accept flow, its access code)",
    simulatedBy: "src/server/email.ts with EMAIL_PROVIDER=capture (the test default): the message is written to email_outbox and marked captured, so nothing is sent",
    real: false,
  },
  // Journey 7: a client request becomes an approved change and a notice in the portal.
  {
    journey: 7,
    external: "The email provider that would send the agency's support reply",
    simulatedBy: "src/server/email.ts with EMAIL_PROVIDER=capture (the test default): support_notification_log and email_outbox record the message as captured, read back through tests/support/support-world.ts",
    real: false,
  },
  // Journey 8: the maintenance plan bought and run through PayPal subscriptions.
  {
    journey: 8,
    external: "The PayPal Subscriptions API (billing plan read, subscription open/read/list/cancel, and webhook signature verification)",
    simulatedBy: "tests/support/paypal-subscriptions.ts fakePaypalSubscriptions, given to src/server/billing/providers/paypal-subscriptions.ts as its wire with createPaypalAdapter({ wire: pp.wire })",
    real: false,
  },
];
