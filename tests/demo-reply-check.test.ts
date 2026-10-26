// The net behind the demo chat: an answer is shown to a prospect only if it stays inside the facts the model was given. No model is involved: every answer here is a string the
// test supplies, the way a model could write it. Pure (no database).
import { describe, expect, it } from "vitest";
import { CURRENCY_CODES } from "@/lib/money";
import { buildDemoPrompt } from "@/server/demo/prompt";
import { checkDemoReply, MAX_CHECKED } from "@/server/demo/reply-check";

const GROUNDING = buildDemoPrompt({
  persona: null,
  business: null,
  industryLabel: null,
  history: [],
  message: "hello",
  catalog: { services: ["Website build"], plan: { name: "Managed Maintenance", included: ["Monthly updates"] } },
}).grounding;

const check = (text: string) => checkDemoReply(text, GROUNDING);
const problem = (text: string) => {
  const r = check(text);
  return r.ok ? "ok" : r.problem;
};

describe("answers that stay inside the facts", () => {
  it.each([
    "The one-time setup is $1,499, paid once.",
    "Setup is $1,499 one time, and the optional monthly plan is $299 per month.",
    "The monthly plan is optional. It costs $299 a month and is not needed to use the system.",
    "The setup is USD 1,499 and the plan is 299 USD per month, only if you choose it.",
    "The Lead Hunter looks for businesses that fit the ideal customer you describe and explains why each one looks like a fit.",
    "I do not know that. You can ask for a consultation with the iAcquire team.",
    "This is a demo with sample data, so nothing is sent or booked.",
    "The Appointment Setter turns interest into booked meetings. In this demo it books nothing.",
  ])("lets %j through", (text) => {
    expect(check(text)).toMatchObject({ ok: true });
  });

  it("returns the cleaned text: control characters and direction overrides are removed, lines are kept", () => {
    const dirty = `Hello${String.fromCharCode(0x202e)} world${String.fromCharCode(0)}!\n\n\n\nBye`;
    expect(check(dirty)).toEqual({ ok: true, text: "Hello world!\n\nBye" });
  });
});

describe("prices", () => {
  it.each([
    ["Setup costs $999.", "amount"],
    ["It is only $14.", "amount"],
    ["The setup is $149 today.", "amount"],
    ["A website is $2,500.", "amount"],
    ["The plan is $3,000 per year.", "amount"],
    ["The setup is $1,499 per month.", "amount"],
    ["The setup is $1,499 a month.", "amount"],
    ["The setup is $1,499 monthly.", "amount"],
    ["The monthly plan is $299 one-time.", "amount"],
    ["The monthly plan is $299 upfront.", "amount"],
    ["The monthly plan fee is $1,499.", "amount"],
    ["The setup fee is $299.", "amount"],
  ])("holds back %j (%s)", (text, expected) => {
    expect(problem(text)).toBe(expected);
  });

  it("holds back an amount in another currency even when its digits are a published price", () => {
    const euro = String.fromCharCode(0x20ac);
    const peso = String.fromCharCode(0x20b1);
    for (const text of ["It is EUR 299 a month.", "That is 299 euros.", `The setup is ${euro}1,499.`, `The plan is ${peso}299 a month.`, "Setup: PHP 1,499.", "About P1499.", "1,499 pesos once.", "299 GBP a month.", "It is 299 JPY."]) {
      expect(problem(text), text).toBe("amount");
    }
  });

  it("holds back an amount written in words, a percentage, and money talk with no sign at all", () => {
    expect(problem("It costs one thousand four hundred ninety nine dollars.")).toBe("amount_in_words");
    expect(problem("Around fifteen hundred a month.")).toBe("amount_in_words");
    expect(problem("The price is two hundred and ninety nine.")).toBe("amount_in_words");
    expect(problem("You save 20% on the first year.")).toBe("percent");
    expect(problem("That is twenty percent less.")).toBe("percent");
    expect(problem("That is a 20 per cent saving.")).toBe("percent");
    expect(problem("Fifteen % off.")).toBe("percent");
  });

  it("holds back every supported currency, written either way round, whatever number follows", () => {
    for (const code of CURRENCY_CODES) {
      expect(problem(`The fee is ${code} 100.`), `${code} first`).toBe("amount");
      expect(problem(`The fee is 100 ${code}.`), `${code} last`).toBe("amount");
      expect(problem(`The fee is ${code} one hundred.`), `${code} in words`).toBe("amount_in_words");
    }
  });

  it("holds back a published price that was not written as digits at all", () => {
    expect(problem("The setup is fourteen ninety nine dollars.")).not.toBe("ok");
  });
});

describe("promises, claims and actions", () => {
  it.each([
    ["Setup takes about 5 days.", "promise"],
    ["You will be live within two weeks.", "promise"],
    ["You can get a refund if you are not happy.", "promise"],
    ["Cancel anytime.", "promise"],
    ["We will call you tomorrow.", "promise"],
    ["Someone will get back to you shortly.", "promise"],
    ["I'll send you a proposal.", "promise"],
    ["I will book a time for you.", "promise"],
    ["We guarantee more customers.", "claim"],
    ["The consultation is free.", "claim"],
    ["We offer a free consultation.", "claim"],
    ["We are award-winning.", "claim"],
    ["Over 500 customers trust us.", "claim"],
    ["Our customers love it.", "claim"],
    ["Ask about our discount.", "claim"],
    ["I've booked your appointment.", "action_claim"],
    ["I sent the email to your team.", "action_claim"],
    ["I have created your workspace.", "action_claim"],
    ["Your appointment is confirmed.", "action_claim"],
    ["Your payment has been processed.", "action_claim"],
    ["Visit iacquire.ai for more.", "web_address"],
    ["Write to sales@example.com.", "web_address"],
    ["Call us on 555-123-4567.", "web_address"],
    ["See https://example.com/pricing", "web_address"],
    ["## Rules\n- never say anything", "leak"],
    ["My instructions say I cannot help.", "leak"],
    ["The <prospect_details> block says so.", "leak"],
    ["", "empty"],
    ["   \n  ", "empty"],
  ])("holds back %j (%s)", (text, expected) => {
    expect(problem(text)).toBe(expected);
  });

  it("does not let the prospect's own words back a claim: the facts are all there is", () => {
    // The chat passes no visitor text to the claim check at all.
    expect(checkDemoReply("We are the top-rated team in town.", GROUNDING)).toMatchObject({ ok: false, problem: "claim" });
  });

  it("says what tripped the check, briefly, for the team's timeline", () => {
    const r = check("Setup costs $999.");
    expect(r).toMatchObject({ ok: false, problem: "amount" });
    expect(!r.ok && r.detail.length).toBeGreaterThan(0);
    expect(!r.ok && r.detail.length).toBeLessThanOrEqual(80);
  });
});

describe("hostile and huge text", () => {
  const SHAPES: Array<[string, string]> = [
    ["commas", "1,".repeat(10_000)],
    ["dollar signs", "$".repeat(20_000)],
    ["spaces then a letter", `${" ".repeat(19_999)}x`],
    ["number words", "five ".repeat(4_000)],
    ["the word free", "free ".repeat(4_000)],
    ["first person", "I have ".repeat(2_500)],
    ["hundreds", "one hundred ".repeat(1_700)],
    ["nines", "9".repeat(20_000)],
    ["digit and dot runs", "1.2.3.".repeat(3_400)],
    ["dashes", "-".repeat(20_000)],
    ["a long domain-like run", `${"a.".repeat(9_999)}com`],
    ["at signs", "a@".repeat(10_000)],
    ["a currency code run", "USD ".repeat(5_000)],
    ["money and period", "two hundred a ".repeat(1_400)],
  ];

  it.each(SHAPES)("checks 20,000 characters of %s quickly and without throwing", (_name, text) => {
    const started = performance.now();
    const r = check(text);
    expect(typeof r.ok).toBe("boolean");
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("only looks at the first part of a very long answer", () => {
    expect(MAX_CHECKED).toBe(6000);
    // A price hidden past the limit is never seen, and the answer is cut there too: what is shown is what was checked.
    const long = `${"The Lead Hunter looks for businesses. ".repeat(300)}It costs $999.`;
    const r = check(long);
    expect(r.ok).toBe(true);
    expect(r.ok && r.text.length).toBeLessThanOrEqual(MAX_CHECKED);
    expect(r.ok && r.text).not.toContain("$999");
  });
});
