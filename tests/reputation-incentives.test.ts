// Rule R4: nothing offered in return for feedback or a review, and no asking for a particular rating. The check BLOCKS: the wording can't be saved as a review-request template, can't
// be approved, can't be a retention program step with the feedback link, and a request that uses it is not sent. Pure parts here; the sending paths are in reputation-survey and
// reputation-retention-link.
import { describe, expect, it } from "vitest";
import { reviewIncentiveFindings } from "@/lib/reputation/incentives";
import { validateTemplate } from "@/lib/messaging/tokens";
import { renderLinkedStep, renderStep, validateSteps } from "@/lib/retention";

const terms = (text: string) => reviewIncentiveFindings(text).map((f) => f.term.toLowerCase());

describe("what counts as an offer in return, or a steer toward a rating", () => {
  it("finds every kind of offer, however it is phrased", () => {
    const offers: Array<[string, string]> = [
      ["Leave a review and get 10% off your next visit", "10% off"],
      ["Review us for a free coffee!", "free"],
      ["A $5 off coupon for your honesty", "coupon"],
      ["We'll send a gift card to everyone who reviews", "gift"],
      ["Earn a reward for your review", "reward"],
      ["In exchange for your review we will help", "in exchange"],
      ["Get 20 percent off if you post one", "percent off"],
      ["Enter to win a prize when you review", "prize"],
      ["Your discount code is waiting", "discount"],
      ["A little thank-you voucher awaits", "voucher"],
      ["Complimentary dessert next time", "complimentary"],
      ["review us and get cashback", "cashback"],
      ["We're running a giveaway for reviewers", "giveaway"],
      ["off your next order if you review", "off your next"],
      ["Reviews earn a bonus", "bonus"],
      ["Take a freebie on the way out", "freebie"],
    ];
    for (const [text, term] of offers) {
      const found = reviewIncentiveFindings(text);
      expect(found.length, text).toBeGreaterThan(0);
      expect(found.every((f) => f.kind === "incentive"), text).toBe(true);
      expect(terms(text).join("|"), text).toContain(term);
    }
  });

  it("finds asking for a particular rating", () => {
    for (const text of ["Please leave us a 5-star review", "We would love a five star rating", "Leave a positive review today", "Rate us with five stars", "A great review would mean a lot"]) {
      const found = reviewIncentiveFindings(text);
      expect(found.length, text).toBeGreaterThan(0);
      expect(found[0].kind, text).toBe("steering");
    }
  });

  it("does not mistake ordinary wording for an offer", () => {
    for (const text of [
      "Feel free to reply to this message.",
      "Hi Ana, thanks for visiting Sunrise Dental. How did we do? {{review.link}}",
      "We'd love to hear how your visit went. Hassle-free, takes a minute.",
      "Call our toll-free number if you need us.",
      "Free to reach us on this number any time.",
      "Your feedback helps us improve.",
      "Rate your visit from 1 to 5 stars.",
      "Tell others about your experience, whatever it was.",
      "Please be honest.",
      "",
      "   ",
    ]) expect(reviewIncentiveFindings(text), text).toEqual([]);
    expect(reviewIncentiveFindings(null)).toEqual([]);
    expect(reviewIncentiveFindings(undefined)).toEqual([]);
  });

  it("reports each find once, in the order it appears, with a message that names the words", () => {
    const f = reviewIncentiveFindings("Free coffee and a free coffee voucher if you review, plus a discount");
    expect(f.map((x) => x.term.toLowerCase())).toEqual(["free", "voucher", "discount"]);
    expect(f[0].message).toContain("Remove");
    expect(f[0].message).toMatch(/in return for feedback or a review/);
    expect(reviewIncentiveFindings("a 5-star review")[0].message).toMatch(/honest review, not for a particular rating/);
  });
});

describe("a review-request template can't be saved or approved with an offer in it", () => {
  const check = (body: string, subject: string | null = null, channel: "sms" | "email" = "sms") => validateTemplate(body, subject, channel, { purpose: "service", kind: "template" });

  it("rejects an offer in a template that carries the customer's link", () => {
    const r = check("Hi {{contact.first_name}}, leave a review and get a free coffee: {{review.link}}");
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("review_incentive");
    expect(r.errors[0].message).toMatch(/Remove “free”/);
    expect(check("Thanks {{contact.first_name}}! A 5-star review would be great {{review.link}}").errors.map((e) => e.code)).toContain("review_steering");
  });

  it("accepts the same words in a template that has no review link, and ordinary review wording", () => {
    expect(check("Hi {{contact.first_name}}, here is your free coffee voucher.").ok).toBe(true);
    expect(check("Hi {{contact.first_name}}, thanks for visiting. How did we do? {{review.link}}").ok).toBe(true);
    // The link counts in the body only; a subject line that mentions an offer next to a body link is still caught, because the whole message is read.
    const email = check("Tell us how it went: {{review.link}}", "Your free gift is inside", "email");
    expect(email.ok).toBe(false);
  });
});

describe("a retention program step may carry the feedback link only where it belongs, and never an offer", () => {
  const step = (body: string) => [{ key: "feedback", delayDays: 2, body }];

  it("allows {feedback_link} once, in the programs that ask for feedback or follow up after a visit", () => {
    for (const kind of ["feedback_request", "service_followup"] as const) expect(validateSteps(step("Hi {name}, how did we do? {feedback_link}"), "service", kind), kind).toEqual([]);
    for (const kind of ["welcome", "onboarding_checkin"] as const) {
      const issues = validateSteps(step("Hi {name}, how did we do? {feedback_link}"), "service", kind);
      expect(issues[0].message, kind).toMatch(/\{feedback_link\} can only be used in the "Ask for feedback" and "Follow up after an appointment" programs/);
    }
    // Promotional messages never carry it, and a caller that doesn't say which program it is gets the strict answer.
    expect(validateSteps(step("Hi {name}, {feedback_link} Reply STOP to opt out."), "marketing", "reengagement")[0].message).toMatch(/can only be used/);
    expect(validateSteps(step("Hi {name}, how did we do? {feedback_link}"), "service")[0].message).toMatch(/can only be used/);
    expect(validateSteps(step("{feedback_link} and again {feedback_link}"), "service", "feedback_request").map((i) => i.message)).toContain("Use {feedback_link} once in a message.");
  });

  it("blocks an offer or a steer toward a rating in a message that carries the link, and leaves plain program messages alone", () => {
    const withLink = (text: string) => validateSteps(step(`Hi {name}, ${text} {feedback_link}`), "service", "feedback_request");
    expect(withLink("tell us how we did and get 10% off your next visit")[0].message).toMatch(/Remove “10% off”/);
    expect(withLink("a free gift awaits")[0].message).toMatch(/Remove “free”/);
    expect(withLink("please give us five stars")[0].message).toMatch(/honest review/);
    expect(withLink("please leave a 5-star review")[0].message).toMatch(/honest review/);
    expect(withLink("please rate your visit from 1 to 5 stars")).toEqual([]);
    // Without the link it is an ordinary program message, which has no such rule here.
    expect(validateSteps(step("Hi {name}, a free coffee is on us."), "service", "feedback_request")).toEqual([]);
  });

  it("fills in the link where it goes and keeps a name from writing a placeholder", () => {
    const v = { name: "Maria Santos", business: "Acme" };
    expect(renderLinkedStep("Hi {name}, how did {business} do? {feedback_link} Thanks.", v, "{{review.link}}")).toBe("Hi Maria, how did Acme do? {{review.link}} Thanks.");
    // A name or a business name with braces can't become a placeholder of its own.
    expect(renderStep("Hi {name}, from {business}", { name: "{{review.link}}", business: "Bad {feedback_link} Co" })).toBe("Hi review.link, from Bad feedback_link Co");
    expect(renderLinkedStep("Hi {name}. {feedback_link}", { name: "{{review.link}}", business: "Acme" }, "{{review.link}}")).toBe("Hi review.link. {{review.link}}");
  });
});
