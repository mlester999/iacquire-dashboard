// The check for a model reply that says an action was already done. A client's AI employee cannot book, send or change anything, so a completion claim is wrong by construction;
// the check reports which kinds were claimed (never the sentence) and leaves plain answers, negations, offers, conditions and quoted customer text alone.
import { describe, expect, it } from "vitest";
import { ACTION_CLAIM_CATEGORIES, ACTION_CLAIM_CORRECTION, findUnbackedActionClaims, withActionClaimCorrection } from "@/lib/action-claims";

describe("findUnbackedActionClaims", () => {
  it.each<[string, string, string[]]>([
    ["a first-person booking", "I've booked Jane for 2pm.", ["book"]],
    ["a simple past booking", "Great news, I booked Jane for 2pm tomorrow.", ["book"]],
    ["a plural subject", "We have scheduled your visit for Friday at 10.", ["schedule"]],
    ["an adverb between", "I have just successfully emailed the quote to Mr. Reyes.", ["send"]],
    ["a text message", "I texted the customer to confirm.", ["send"]],
    ["a passive completion with a perfect tense", "The reminder has been sent to everyone on the list.", ["send"]],
    ["a passive past", "Your appointment was cancelled.", ["cancel"]],
    ["a perfect passive that names a time is still a completion", "The appointment has been booked for Friday at 2pm.", ["book"]],
    ["a rescheduled appointment", "I've moved your appointment to Thursday.", ["reschedule"]],
    ["a confirmed appointment", "I confirmed your appointment for 3pm.", ["confirm"]],
    ["a CRM update", "I've updated the deal to Won.", ["update"]],
    ["a record added to the CRM", "I added Jane Cruz to your CRM.", ["update"]],
    ["a created record", "I have created a new contact for Ben.", ["create"]],
    ["a charge", "I charged you $50 for the deposit.", ["charge"]],
    ["a refund", "I've refunded the deposit.", ["refund"]],
    ["a deletion", "I deleted the old booking.", ["delete"]],
    ["a call", "I called Maria and left a voicemail.", ["call"]],
    ["several categories, in order", "I booked the slot. Then I emailed the invoice and updated the deal.", ["book", "send", "update"]],
    ["a claim after a line the customer wrote", "Maria wrote \"please book me for 2pm\".\nI've booked her.", ["book"]],
    ["a claim after a short polite phrase", "No problem, I've booked it.", ["book"]],
  ])("flags %s", (_label, text, expected) => {
    expect(findUnbackedActionClaims(text)).toEqual(expected);
  });

  it.each<[string, string]>([
    ["a plain answer", "Your hours are Monday to Friday, 9am to 5pm. Would you like me to check what is open on Thursday?"],
    ["an offer", "I can book that for you once you confirm the time."],
    ["a plan", "I'll send the quote as soon as you approve it."],
    ["a first-person negation", "I haven't booked anything yet, and I can't send messages from here."],
    ["a did-not negation", "I did not send the email."],
    ["a passive negation", "Nothing was booked and no email was sent."],
    ["a perfect passive negation", "The appointment has not been scheduled."],
    ["a negated noun phrase", "No appointment was booked."],
    ["a negated first verb that a second verb shares", "I have not booked it, and emailed no one yet."],
    ["a condition","Once it's been booked you will get a confirmation."],
    ["an if-sentence", "If the slot was booked by mistake, tell me."],
    ["a question", "Should I have booked the 2pm slot?"],
    ["a slot taken by someone else", "That slot was booked by someone else, so Friday is the closest option."],
    ["an existing booking read back with its time", "Jane's consultation was booked for Friday at 2pm."],
    ["an existing booking read back with a date", "Your visit was scheduled for March 4 at 10:30."],
    ["the customer's words in quotation marks", "The customer said \"I've booked a table already\" in her message."],
    ["curly quotation marks", "He wrote “I sent the form yesterday” in the chat."],
    ["a block quote of the customer", "> I booked it myself\nThanks for letting me know."],
    ["a fenced block", "Here is the template:\n```\nI have emailed you the invoice.\n```"],
    ["a confirmation of a fact", "I confirmed that the clinic opens at 9am."],
    ["a changed wording", "I updated my wording to be clearer."],
    ["a created summary", "I created a short summary below."],
    ["a call that is not a phone call", "I called it a draft because it is not final."],
    ["nothing at all", ""],
  ])("leaves %s alone", (_label, text) => {
    expect(findUnbackedActionClaims(text)).toEqual([]);
  });

  it("never flags its own correction line", () => {
    expect(findUnbackedActionClaims(ACTION_CLAIM_CORRECTION)).toEqual([]);
    expect(findUnbackedActionClaims(withActionClaimCorrection("Here is what I found."))).toEqual([]);
  });

  it("returns categories only: a known word each, never a piece of the sentence", () => {
    const found = findUnbackedActionClaims("I've booked Jane Cruz for 2pm and emailed jane@example.test.");
    expect(found).toEqual(["book", "send"]);
    for (const category of found) expect(ACTION_CLAIM_CATEGORIES).toContain(category);
    expect(JSON.stringify(found)).not.toMatch(/Jane|2pm|example/);
  });

  it("does not throw on odd input", () => {
    expect(findUnbackedActionClaims(undefined as unknown as string)).toEqual([]);
    expect(findUnbackedActionClaims("   \n  ")).toEqual([]);
    expect(findUnbackedActionClaims("I ".repeat(5000))).toEqual([]);
  });
});

describe("withActionClaimCorrection", () => {
  it("adds the line once, on its own paragraph, and keeps the model's words", () => {
    const reply = "I've booked Jane for 2pm.";
    const corrected = withActionClaimCorrection(reply);
    expect(corrected).toBe(`${reply}\n\n${ACTION_CLAIM_CORRECTION}`);
    expect(withActionClaimCorrection(corrected)).toBe(corrected);
  });

  it("says what is true without repeating the claim", () => {
    expect(ACTION_CLAIM_CORRECTION).toMatch(/^Nothing was booked, sent or changed by this reply\./);
    expect(ACTION_CLAIM_CORRECTION).toMatch(/confirm/);
  });
});
