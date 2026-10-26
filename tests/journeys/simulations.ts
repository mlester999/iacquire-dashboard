// What each journey test simulates, and with what. A journey follows a business process across services, so it necessarily meets systems that are not this
// repository: a payment provider, a messaging provider, a language model, a phone system, an outside API. None of them is contacted by a test (tests/support/
// no-network.ts refuses the socket), so each journey records here exactly which system stands behind the boundary and which existing seam stands in for it.
//
// The rule this file exists for: a journey may only claim an external effect it did not really make. If an entry ever says `real: true`, it means a test
// reached the system itself, and tests/journeys/journeys.test.ts fails.
//
// Journeys 5-8 are written alongside this one and keep their entries in ./simulations-5-8.ts; they are merged below so the registry is one list. That file
// imports the entry type from here as a type only, so there is no runtime cycle.
import { SIMULATIONS_5_8 } from "./simulations-5-8";

export interface Simulation {
  /** The journey test this entry belongs to: 1 to 8. */
  journey: number;
  /** The external system the journey would otherwise reach. */
  external: string;
  /** The existing seam that stands in for it: the mock, the stub, or the replaced transport, named by file. */
  simulatedBy: string;
  /** Always false here. A true entry would mean the test made the outside call for real, which no journey may do. */
  real: boolean;
}

/** Journey 1: a purchase invitation becomes a client workspace. */
const JOURNEY_1: Simulation[] = [
  {
    journey: 1,
    external: "PayMongo checkout creation (the hosted payment page)",
    simulatedBy: "tests/support/billing.ts mockCheckoutFetch (a fetch stand-in answering with a made-up checkout id)",
    real: false,
  },
  {
    journey: 1,
    external: "PayMongo payment webhook (the signed 'checkout paid' notice)",
    simulatedBy: "tests/support/billing.ts paymongoPaidEvent + signPaymongo (a hand-written body signed with a made-up webhook secret)",
    real: false,
  },
];

/** Journey 2: a website chat visitor becomes a lead with a recorded source. */
const JOURNEY_2: Simulation[] = [
  {
    journey: 2,
    external: "The language model that answers the website chat",
    simulatedBy: "tests/support/webchat.ts answer() (a ReplyGenerator stub returning fixed text and recording what it was asked)",
    real: false,
  },
  {
    journey: 2,
    external: "The messaging provider that would deliver a follow-up or a promotion",
    simulatedBy: "src/server/messaging/send.ts evaluateSend (the send chain's own decision, where the visitor-typed-contact rule lives) is asked and no message is dispatched; tests/support/messaging.ts recordingProvider is the seam for any send",
    real: false,
  },
];

/** Journey 3: a missed call becomes a recovery case and a recovery text. */
const JOURNEY_3: Simulation[] = [
  {
    journey: 3,
    external: "The phone system that reports the missed call",
    simulatedBy: "tests/support/missed-calls.ts voice() + recordCall (a hand-written end-of-call report fed to the real intake)",
    real: false,
  },
  {
    journey: 3,
    external: "The SMS provider that carries the recovery text",
    simulatedBy: "tests/support/messaging.ts recordingProvider (records the send chain's request and answers with an acceptance or a refusal)",
    real: false,
  },
];

/** Journey 4: Automation Studio, from the plan gate to a finished run and a lapse. */
const JOURNEY_4: Simulation[] = [
  {
    journey: 4,
    external: "The outside system behind an Automation Studio connection (a Slack incoming webhook, and the HTTPS API it was verified against)",
    simulatedBy: "tests/support/studio-workspace.ts and this journey replace the pinned HTTPS transport (pinnedHttps.request) and answer with a recorded stand-in response",
    real: false,
  },
];

/** Every external system the journeys in this checkout simulate, with the seam that stands in for it. */
export const SIMULATIONS: Simulation[] = [...JOURNEY_1, ...JOURNEY_2, ...JOURNEY_3, ...JOURNEY_4, ...SIMULATIONS_5_8];
