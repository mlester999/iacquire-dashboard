// @vitest-environment jsdom
// The demo's interactive pieces, clicked through: the prospect's chat and request form (what is sent, what a failed or doubtful send does to the key that keeps a message from
// being counted twice, where the focus goes) and the agency's controls (what each dialog asks before it changes anything, what is sent, what is shown afterwards, and that an
// invitation link reaches the browser only when the email did not go). The server is replaced by recorders: the rules are covered in the other demo tests. The layout at 375 and
// 1280 px is for the lead's browser pass; here are the labels, roles, states and calls.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const names = [
    "extendDemoAction", "expireDemoAction", "blockProspectAction", "declineProspectAction", "reopenProspectAction", "assignProspectAction", "addProspectNoteAction", "consultationDoneAction",
    "readTranscriptAction", "exportProspectAction", "eraseProspectAction", "convertProspectAction", "saveDemoSettingsAction",
  ] as const;
  return {
    actions: Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>,
    refresh: vi.fn(),
    push: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, back: vi.fn() }), usePathname: () => "/admin/prospects" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/actions/demo-admin", () => mocks.actions);
vi.mock("@/components/ui/overlays", async () => {
  const React = await import("react");
  function Dialog({ open, title, description, children, footer }: { open: boolean; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode }) {
    if (!open) return null;
    return (
      <section role="dialog" aria-label={typeof title === "string" ? title : undefined}>
        <h2>{title}</h2>
        {description && <div>{description}</div>}
        {children}
        <footer>{footer}</footer>
      </section>
    );
  }
  return { Dialog };
});

import { DemoChat } from "@/components/demo/chat";
import { DemoRequestForm } from "@/components/demo/request-form";
import { ProspectActions } from "@/components/demo/admin/prospect-actions";
import { DemoSettingsForm } from "@/components/demo/admin/settings-form";
import { availableActions, type ActionFacts } from "@/lib/demo/admin-view";
import { FIELD_COPY, LINK_SENT_COPY } from "@/lib/demo/copy";
import { DEMO_INDUSTRIES } from "@/lib/demo/industries";
import { demoNotice } from "@/lib/demo/notice";
import { DEMO_DEFAULTS } from "@/lib/demo/settings";
import type { RoomChatState, RoomLine } from "@/lib/demo/room-types";

const ok = (data: unknown = true) => ({ ok: true, data });
const fail = (error: string, code = "invalid_input") => ({ ok: false, error, code });

/** A response the components can read: they only ever call .json(). */
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const fn of Object.values(mocks.actions)) fn.mockReset();
  for (const fn of [mocks.refresh, mocks.push, mocks.toastSuccess, mocks.toastError]) fn.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The chat
// ---------------------------------------------------------------------------

const ROLES = [{ key: "lead_hunter", name: "AI Lead Hunter" }, { key: "appointment_setter", name: "AI Appointment Setter" }];
const line = (over: Partial<RoomLine> = {}): RoomLine => ({ id: "1", seq: 1, role: "user", employeeRole: null, body: "Hello", state: "answered", at: "2026-11-02T09:00:00.000Z", ...over });
const chatState = (over: Partial<RoomChatState> = {}): RoomChatState => ({ transcript: [], messagesLeft: 10, messageAllowance: 10, canSend: true, refusalMessage: null, ...over });
const FALLBACK = "11111111-2222-4333-8444-555555555555";

function chat(over: Partial<React.ComponentProps<typeof DemoChat>> = {}) {
  return render(<DemoChat initial={chatState()} roles={ROLES} fallbackMessageId={FALLBACK} pageNotice={null} {...over} />);
}
const question = () => screen.getByLabelText("Your question") as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: /^Send$/ });
const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body as string) as Record<string, unknown>;
const roomAfter = (over: Record<string, unknown> = {}) => ({
  transcript: [line(), line({ id: "2", seq: 2, role: "assistant", body: "Here is the answer.", state: null, employeeRole: "lead_hunter" })],
  messagesLeft: 9,
  messageAllowance: 10,
  chat: { canSend: true, refusalMessage: null },
  ...over,
});

describe("the chat", () => {
  it("shows the conversation with who said what, and what did not count", () => {
    chat({
      initial: chatState({
        transcript: [
          line({ id: "1", body: "What do you do?" }),
          line({ id: "2", seq: 2, role: "assistant", body: "I help.", state: null, employeeRole: "lead_hunter" }),
          line({ id: "3", seq: 3, role: "assistant", body: "From the team.", state: null }),
          line({ id: "4", seq: 4, body: "No answer came", state: "failed" }),
          line({ id: "5", seq: 5, body: "Still thinking", state: "pending" }),
        ],
      }),
    });
    const log = screen.getByRole("log", { name: "AQi conversation" });
    expect(within(log).getAllByText("You")).toHaveLength(3);
    expect(within(log).getByText("AI Lead Hunter (AI)")).toBeTruthy();
    // An answer that is not from one named employee is AQi's, the demo guide.
    expect(within(log).getByText("AQi")).toBeTruthy();
    expect(within(log).getByText("Not counted: no answer came.")).toBeTruthy();
    expect(within(log).getByText("Waiting for an answer.")).toBeTruthy();
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("tabindex")).toBe("0");
  });

  it("invites a first question when there is nothing yet", () => {
    chat();
    expect(screen.getByText(/Nothing here yet\. Ask AQi/)).toBeTruthy();
    expect(screen.getByText("10 of 10 messages left")).toBeTruthy();
  });

  it("is a plain form without scripts: a post to the demo API with the key already in it", () => {
    const { container } = chat();
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/public/demo/message");
    expect((container.querySelector('input[name="clientMessageId"]') as HTMLInputElement).value).toBe(FALLBACK);
    expect(question().getAttribute("name")).toBe("text");
    expect(question().maxLength).toBe(1000);
    expect(question().required).toBe(true);
    expect((screen.getByLabelText("Ask") as HTMLSelectElement).getAttribute("name")).toBe("employeeRole");
    expect([...(screen.getByLabelText("Ask") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Any AI Employee", "AI Lead Hunter", "AI Appointment Setter"]);
  });

  it("sends the question as JSON to the demo API with a key, and shows the conversation the server returns", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, kind: "answered", room: roomAfter() }));
    chat();
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "lead_hunter" } });
    fireEvent.change(question(), { target: { value: "  What do you do?  " } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText("Here is the answer.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/public/demo/message");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" } });
    expect(sentBody()).toEqual({ text: "What do you do?", clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/), employeeRole: "lead_hunter" });
    expect(screen.getByText("9 of 10 messages left")).toBeTruthy();
    expect(question().value).toBe("");
    // The focus goes back to the box so the next question can be typed at once.
    await waitFor(() => expect(document.activeElement).toBe(question()));
  });

  it("shows the visitor's own message at once, empties the box, and shows the employee they asked, not AQi, as the one writing", async () => {
    let finish: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    chat();
    fireEvent.change(screen.getByLabelText("Ask"), { target: { value: "appointment_setter" } });
    fireEvent.change(question(), { target: { value: "What do you do?" } });
    fireEvent.click(sendButton());
    const log = screen.getByRole("log", { name: "AQi conversation" });
    // Before any answer: the message is already in the conversation, the box is empty, and it cannot be edited while the message is on its way.
    expect(within(log).getByText("What do you do?")).toBeTruthy();
    expect(within(log).getByText("You")).toBeTruthy();
    expect(question().value).toBe("");
    expect(question().readOnly).toBe(true);
    // The employee that was asked is the one writing, with their own name, and it is said aloud once.
    expect(within(log).getByText("AI Appointment Setter (AI)")).toBeTruthy();
    expect(within(log).getByText("AI Appointment Setter is writing an answer.")).toBeTruthy();
    expect(within(log).queryByText("AQi")).toBeNull();
    finish(reply({ ok: true, kind: "answered", room: roomAfter() }));
    await waitFor(() => expect(screen.getByText("Here is the answer.")).toBeTruthy());
    // The record replaces the picture of the message, so nothing is shown twice, and nobody is writing any more.
    expect(within(log).queryByText("What do you do?")).toBeNull();
    expect(within(log).getAllByText("Hello")).toHaveLength(1);
    expect(within(log).queryByText(/is writing an answer/)).toBeNull();
    expect(question().readOnly).toBe(false);
  });

  it("shows AQi as the one writing when no one in particular was asked", () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    chat();
    fireEvent.change(question(), { target: { value: "Hi there" } });
    fireEvent.click(sendButton());
    const log = screen.getByRole("log", { name: "AQi conversation" });
    expect(within(log).getByText("Hi there")).toBeTruthy();
    expect(within(log).getByText("AQi")).toBeTruthy();
    expect(within(log).getByText("AQi is writing an answer.")).toBeTruthy();
  });

  it("takes the message back out of the conversation and into the box when it did not go through, ready to send again", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    chat();
    fireEvent.change(question(), { target: { value: "Will this arrive?" } });
    fireEvent.click(sendButton());
    await screen.findByText(/could not confirm your message was sent/i);
    const log = screen.getByRole("log", { name: "AQi conversation" });
    expect(within(log).queryByText("Will this arrive?")).toBeNull();
    expect(within(log).queryByText(/is writing an answer/)).toBeNull();
    expect(question().value).toBe("Will this arrive?");
    expect(question().readOnly).toBe(false);
  });

  it("does not send an empty question, or one of only spaces", () => {
    chat();
    fireEvent.click(sendButton());
    fireEvent.change(question(), { target: { value: "    \n  " } });
    fireEvent.submit(question().closest("form")!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a new key for the next question once the server has answered for the last one", async () => {
    fetchMock.mockResolvedValue(reply({ ok: true, kind: "answered", room: roomAfter() }));
    chat();
    for (const text of ["First", "Second"]) {
      fireEvent.change(question(), { target: { value: text } });
      fireEvent.click(sendButton());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(text === "First" ? 1 : 2));
      await waitFor(() => expect(question().value).toBe(""));
    }
    expect(sentBody(0).clientMessageId).not.toBe(sentBody(1).clientMessageId);
  });

  it("keeps the same key when it cannot tell whether the message arrived, so pressing Send again can never count it twice", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(reply("<html>gateway</html>" as unknown as object)).mockResolvedValueOnce(reply({ ok: true, kind: "answered", room: roomAfter() }));
    chat();
    fireEvent.change(question(), { target: { value: "Will this arrive?" } });
    fireEvent.click(sendButton());
    await screen.findByText(/could not confirm your message was sent/i);
    expect(question().value).toBe("Will this arrive?");
    fireEvent.click(sendButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody(1).clientMessageId).toBe(sentBody(0).clientMessageId);
    // A reply that is not JSON at all is also "cannot tell".
    await screen.findByText(/could not confirm your message was sent/i);
    fireEvent.click(sendButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sentBody(2).clientMessageId).toBe(sentBody(0).clientMessageId);
  });

  it("sends one request for a double press while one is on its way", async () => {
    let finish: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    chat();
    fireEvent.change(question(), { target: { value: "Pressed twice" } });
    const button = sendButton();
    fireEvent.click(button);
    fireEvent.submit(question().closest("form")!);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Sending/ }).hasAttribute("disabled")).toBe(true);
    finish(reply({ ok: true, kind: "answered", room: roomAfter() }));
    await waitFor(() => expect(screen.getByText("Here is the answer.")).toBeTruthy());
  });

  it("says a message was given back, keeps what was typed so it can be tried again, and uses the record for the count", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, kind: "held", why: "reply_blocked", message: "The assistant's answer was held back by a safety check, so your message was not counted.", room: roomAfter({ transcript: [line({ state: "failed" })], messagesLeft: 10 }) }));
    chat();
    fireEvent.change(question(), { target: { value: "How much is it?" } });
    fireEvent.click(sendButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("held back by a safety check");
    expect(question().value).toBe("How much is it?");
    expect(screen.getByText("10 of 10 messages left")).toBeTruthy();
    expect(screen.getByText("Not counted: no answer came.")).toBeTruthy();
  });

  it("ends the form when the demo itself refuses, with the server's sentence, and keeps it open for a busy moment", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: { code: "limit_reached", message: "You have used all of your demo messages." } }, 409));
    chat();
    fireEvent.change(question(), { target: { value: "One more" } });
    fireEvent.click(sendButton());
    // Said once, where the form was, as a status; not also as an alert above it.
    const said = await screen.findByText("You have used all of your demo messages.");
    expect(said.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Your question")).toBeNull();
    cleanup();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: { code: "rate_limited", message: "You are sending messages too fast. Wait a moment and try again." } }, 429));
    chat();
    fireEvent.change(question(), { target: { value: "Too quick" } });
    fireEvent.click(sendButton());
    await screen.findByText("You are sending messages too fast. Wait a moment and try again.");
    expect(question().value).toBe("Too quick");
    expect(screen.getByLabelText("Your question")).toBeTruthy();
  });

  it("shows the reason on the page when the chat cannot be used, and no form", () => {
    chat({ initial: chatState({ canSend: false, refusalMessage: "Your demo window has ended. You can still read your conversation and ask for a consultation.", transcript: [line()] }) });
    expect(screen.getByRole("status").textContent).toContain("Your demo window has ended");
    expect(screen.queryByLabelText("Your question")).toBeNull();
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("shows what a form without scripts was sent back with", () => {
    chat({ pageNotice: { tone: "error", text: "That message could not be sent to the assistant, so it was not counted." } });
    expect(screen.getByRole("alert").textContent).toContain("was not counted");
  });

  it("shows a message's words as text", () => {
    const { container } = chat({ initial: chatState({ transcript: [line({ body: "<img src=x onerror=alert(1)> <b>bold</b>" })] }) });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)> <b>bold</b>")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The request form
// ---------------------------------------------------------------------------

function requestForm(over: Partial<React.ComponentProps<typeof DemoRequestForm>> = {}) {
  return render(<DemoRequestForm industries={DEMO_INDUSTRIES} notice={demoNotice(90)} utm={{}} {...over} />);
}
function fillIn(over: { name?: string; email?: string; business?: string; industry?: string; consent?: boolean; marketing?: boolean; trap?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: over.name ?? "Pat Prospect" } });
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: over.email ?? "pat@example.test" } });
  fireEvent.change(screen.getByLabelText("Business name"), { target: { value: over.business ?? "Pat's Roofing" } });
  fireEvent.change(screen.getByLabelText("Industry"), { target: { value: over.industry ?? DEMO_INDUSTRIES[0].value } });
  if (over.consent !== false) fireEvent.click(screen.getByLabelText(new RegExp(demoNotice(90).consent.slice(0, 20))));
  if (over.marketing) fireEvent.click(screen.getByLabelText(/Also send me occasional emails/));
  if (over.trap !== undefined) fireEvent.change(document.querySelector('input[name="company_website"]')!, { target: { value: over.trap } });
}
const submitButton = () => screen.getByRole("button", { name: /Email me my demo link/ });

describe("the request form", () => {
  it("labels every field, asks for a work address, and shows the notice and what is kept", () => {
    const { container } = requestForm();
    for (const label of ["Your name", "Work email", "Business name", "Industry"]) expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByLabelText("Work email").getAttribute("type")).toBe("email");
    expect(screen.getByLabelText("Work email").getAttribute("autocomplete")).toBe("email");
    expect((screen.getByLabelText("Industry") as HTMLSelectElement).value).toBe("");
    const consent = screen.getByLabelText(new RegExp(demoNotice(90).consent.slice(0, 20))) as HTMLInputElement;
    expect(consent.required).toBe(true);
    expect(consent.checked).toBe(false);
    expect((screen.getByLabelText(/Also send me occasional emails/) as HTMLInputElement).checked).toBe(false);
    for (const d of demoNotice(90).details) expect(screen.getByText(d)).toBeTruthy();
    expect(container.querySelector("form")!.getAttribute("action")).toBe("/api/public/demo/start");
    expect(container.querySelector("form")!.getAttribute("method")).toBe("post");
  });

  it("sends the fields as JSON to the demo API, nothing in the address, and then says to check email", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true, message: LINK_SENT_COPY }));
    requestForm({ utm: { utm_source: "newsletter" } });
    fillIn({ marketing: true });
    fireEvent.click(submitButton());
    await screen.findByText("Check your email");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/public/demo/start");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" } });
    expect(sentBody()).toEqual({
      utm_source: "newsletter", name: "Pat Prospect", email: "pat@example.test", business: "Pat's Roofing", industry: DEMO_INDUSTRIES[0].value, consent: true, marketingOptIn: true, company_website: "",
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(LINK_SENT_COPY);
    // The form is gone and the focus is on the result, so a screen reader hears it.
    expect(screen.queryByLabelText("Your name")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("sends what a program typed into the hidden field, so the server can tell it was one", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    requestForm();
    fillIn({ trap: "https://spam.example" });
    fireEvent.click(submitButton());
    await screen.findByText("Check your email");
    expect(sentBody().company_website).toBe("https://spam.example");
  });

  it("keeps what was typed and names the fields that failed, beside them", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: { code: "invalid", message: "Please check the details and try again." }, fields: { email: FIELD_COPY.email, consent: FIELD_COPY.consent } }, 400));
    requestForm();
    // The browser's own checks (a required box, a well-formed address) come first; this is what the server says about an address a browser accepts.
    fillIn({ email: "pat@example" });
    fireEvent.click(submitButton());
    await screen.findByText(FIELD_COPY.email);
    expect(screen.getByText(FIELD_COPY.consent)).toBeTruthy();
    expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("pat@example");
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Pat Prospect");
    expect(screen.getByLabelText("Work email").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Your name").getAttribute("aria-invalid")).toBeNull();
  });

  it("shows a refusal that is not about a field as an alert, and keeps the form for another try", async () => {
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: { code: "rate_limited", message: "Too many tries. Please wait a little and try again." } }, 429));
    requestForm();
    fillIn();
    fireEvent.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many tries");
    expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("pat@example.test");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
  });

  it("says so when the connection fails, and when the answer cannot be read", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    requestForm();
    fillIn();
    fireEvent.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Check your connection");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => Promise.reject(new Error("not json")) });
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be sent"));
  });

  it("does not send twice while the first request is on its way", async () => {
    let finish: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    requestForm();
    fillIn();
    fireEvent.click(submitButton());
    expect(screen.getByRole("button", { name: /Sending/ }).hasAttribute("disabled")).toBe(true);
    // Enter in a field submits the form again while the first request is still on its way.
    fireEvent.submit(screen.getByLabelText("Your name").closest("form")!);
    fireEvent.submit(screen.getByLabelText("Your name").closest("form")!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(reply({ ok: true }));
    await screen.findByText("Check your email");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the fields a form without scripts was sent back with, from the field names only", () => {
    requestForm({ initialErrors: ["name", "industry"] });
    expect(screen.getByText(FIELD_COPY.name)).toBeTruthy();
    expect(screen.getByText(FIELD_COPY.industry)).toBeTruthy();
    expect(screen.queryByText(FIELD_COPY.email)).toBeNull();
  });

  it("offers each industry the questionnaire offers", () => {
    requestForm();
    const options = [...(screen.getByLabelText("Industry") as HTMLSelectElement).options].filter((o) => o.value);
    expect(options.map((o) => o.value)).toEqual(DEMO_INDUSTRIES.map((o) => o.value));
  });
});

// ---------------------------------------------------------------------------
// The agency's controls
// ---------------------------------------------------------------------------

const ID = "3f2c9a4e-0b1d-4c7a-9e55-6a1b2c3d4e5f";
const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  status: "active", access: "open", erased: false, verified: true, messageCount: 4, consultationRequested: true, consultationDone: false, conversionInProgress: false, converted: false,
  extension: { hoursLeft: 48, messagesLeft: 10 }, ...over,
});
const OWNERS = [{ id: "u1", name: "Mia Manager" }, { id: "u2", name: "Sam Super" }];

function controls(over: Partial<React.ComponentProps<typeof ProspectActions>> = {}, f: Partial<ActionFacts> = {}) {
  return render(
    <ProspectActions id={ID} actions={availableActions(facts(f), { view: true, manage: true })} owners={OWNERS} ownerUserId={null} extension={{ hoursLeft: 48, messagesLeft: 10 }} defaults={{ business: "Pat's Roofing", email: "pat@example.test" }} timeZone="UTC" {...over} />,
  );
}
const dialog = (name: string | RegExp) => screen.getByRole("dialog", { name });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const typeIn = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("reading a conversation", () => {
  it("is a button that records the read, shows the lines, and can be hidden", async () => {
    mocks.actions.readTranscriptAction.mockResolvedValue(ok({
      prospectId: ID,
      lines: [
        { id: "1", seq: 1, role: "user", employeeRole: null, body: "What does it cost?", state: "answered", at: "2026-11-02T09:00:00.000Z" },
        { id: "2", seq: 2, role: "assistant", employeeRole: null, body: "<b>The setup is one time.</b>", state: null, at: "2026-11-02T09:00:05.000Z" },
        { id: "3", seq: 3, role: "user", employeeRole: null, body: "And then?", state: "failed", at: "2026-11-02T09:01:00.000Z" },
      ],
    }));
    controls();
    expect(screen.queryByText("What does it cost?")).toBeNull();
    press("Read the conversation");
    await screen.findByText("What does it cost?");
    expect(mocks.actions.readTranscriptAction).toHaveBeenCalledWith(ID);
    expect(screen.getByRole("status").textContent).toContain("That was recorded on the timeline and in the audit log");
    expect(screen.getByText("<b>The setup is one time.</b>")).toBeTruthy();
    expect(screen.getByText(/not counted \(no answer came\)/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Conversation" })).getAllByRole("listitem")).toHaveLength(3);
    press("Hide the conversation");
    expect(screen.queryByText("What does it cost?")).toBeNull();
  });

  it("says what went wrong and shows nothing when the read is refused", async () => {
    mocks.actions.readTranscriptAction.mockResolvedValue(fail("Your agency role does not include demo prospects.", "forbidden"));
    controls();
    press("Read the conversation");
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Your agency role does not include demo prospects."));
    expect(screen.getByRole("alert").textContent).toContain("does not include demo prospects");
    expect(screen.queryByRole("list", { name: "Conversation" })).toBeNull();
  });

  it("says they wrote nothing, rather than showing an empty box", async () => {
    mocks.actions.readTranscriptAction.mockResolvedValue(ok({ prospectId: ID, lines: [] }));
    controls();
    press("Read the conversation");
    await screen.findByText("They wrote nothing.");
  });
});

describe("the changes that need a reason", () => {
  const cases = [
    { name: "End now", title: "End this demo now", confirm: "End the demo", action: "expireDemoAction", done: "The demo has ended." },
    { name: "Block", title: "Block this prospect", confirm: "Block", action: "blockProspectAction", done: "Blocked." },
    { name: "Not a fit", title: "Mark as not a fit", confirm: "Mark as not a fit", action: "declineProspectAction", done: "Marked as not a fit." },
    { name: "Erase", title: "Erase this prospect's details", confirm: "Erase their details", action: "eraseProspectAction", done: "Their details were erased." },
  ] as const;

  it.each(cases)("asks why before it does '$name', says what it does, and sends the reason", async ({ name, title, confirm, action, done }) => {
    mocks.actions[action].mockResolvedValue(ok());
    controls();
    press(name);
    const d = dialog(title);
    const confirmButton = () => within(d).getByRole("button", { name: confirm });
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(d).getByLabelText(/^Why/), { target: { value: "abc" } });
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(d).getByLabelText(/^Why/), { target: { value: "Duplicate request" } });
    expect(confirmButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.actions[action]).toHaveBeenCalledWith(ID, "Duplicate request"));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(done));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says in the erase dialog that it cannot be undone and what goes", () => {
    controls();
    press("Erase");
    const t = dialog(/Erase this prospect/).textContent ?? "";
    expect(t).toContain("This cannot be undone.");
    for (const word of ["name", "email address", "business name", "conversation", "links", "the words your team wrote about them"]) expect(t, word).toContain(word);
  });

  it("keeps the dialog open and shows the server's sentence when the change is refused, and clears the reason on cancel", async () => {
    mocks.actions.blockProspectAction.mockResolvedValue(fail("Only a Super Admin can change the demo funnel.", "forbidden"));
    controls();
    press("Block");
    const d = dialog("Block this prospect");
    fireEvent.change(within(d).getByLabelText(/^Why/), { target: { value: "Abusive messages" } });
    fireEvent.click(within(d).getByRole("button", { name: "Block" }));
    await within(d).findByText("Only a Super Admin can change the demo funnel.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    press("Block");
    expect((within(dialog("Block this prospect")).getByLabelText(/^Why/) as HTMLTextAreaElement).value).toBe("");
  });

  it("sends one request for a double press of the confirm button", async () => {
    let finish: (v: unknown) => void = () => undefined;
    mocks.actions.eraseProspectAction.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    controls();
    press("Erase");
    const d = dialog(/Erase this prospect/);
    fireEvent.change(within(d).getByLabelText(/^Why/), { target: { value: "Asked to be removed" } });
    const confirm = within(d).getByRole("button", { name: "Erase their details" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.actions.eraseProspectAction).toHaveBeenCalledTimes(1);
    finish(ok());
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
});

describe("extending a demo", () => {
  it("states what can still be added, bounds the inputs by it, needs a reason, and sends numbers", async () => {
    mocks.actions.extendDemoAction.mockResolvedValue(ok({ windowEndsAt: "2026-11-05T09:00:00.000Z", extraMessages: 5, reactivated: false }));
    controls({ extension: { hoursLeft: 48, messagesLeft: 10 } });
    press("Extend");
    const d = dialog("Extend this demo");
    expect(d.textContent).toContain("up to 48 more hours and 10 more messages");
    const hours = within(d).getByLabelText("Hours to add") as HTMLInputElement;
    const messages = within(d).getByLabelText("Messages to add") as HTMLInputElement;
    expect([hours.min, hours.max, messages.min, messages.max]).toEqual(["0", "48", "0", "10"]);
    expect(hours.getAttribute("inputmode")).toBe("numeric");
    const go = () => within(d).getByRole("button", { name: "Extend" });
    expect(go().hasAttribute("disabled")).toBe(true);
    fireEvent.change(hours, { target: { value: "12" } });
    fireEvent.change(messages, { target: { value: "5" } });
    fireEvent.change(within(d).getByLabelText(/^Why/), { target: { value: "Asked for a second look" } });
    fireEvent.click(go());
    await waitFor(() => expect(mocks.actions.extendDemoAction).toHaveBeenCalledWith(ID, { hours: 12, extraMessages: 5, reason: "Asked for a second look" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("The demo was extended."));
  });

  it("shows the server's refusal in the dialog (an extension past the limits is refused there, not here)", async () => {
    mocks.actions.extendDemoAction.mockResolvedValue(fail("That is more than the most that can be added to one prospect."));
    controls();
    press("Extend");
    const d = dialog("Extend this demo");
    fireEvent.change(within(d).getByLabelText(/^Why/), { target: { value: "More time please" } });
    fireEvent.click(within(d).getByRole("button", { name: "Extend" }));
    await within(d).findByText("That is more than the most that can be added to one prospect.");
  });

  it("is not offered when nothing more can be added", () => {
    controls({}, { extension: { hoursLeft: 0, messagesLeft: 0 } });
    expect(screen.queryByRole("button", { name: "Extend" })).toBeNull();
  });
});

describe("the quick changes", () => {
  it("saves who follows the prospect, only when it changed, and 'nobody' as none", async () => {
    mocks.actions.assignProspectAction.mockResolvedValue(ok());
    controls({ ownerUserId: "u1" });
    const save = () => screen.getByRole("button", { name: "Save" });
    expect(save().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Followed by"), { target: { value: "u2" } });
    expect(save().hasAttribute("disabled")).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(mocks.actions.assignProspectAction).toHaveBeenCalledWith(ID, "u2"));
    fireEvent.change(screen.getByLabelText("Followed by"), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(mocks.actions.assignProspectAction).toHaveBeenLastCalledWith(ID, null));
  });

  it("adds a note, says it is kept with the prospect and erased with them, and clears the box", async () => {
    mocks.actions.addProspectNoteAction.mockResolvedValue(ok());
    controls();
    expect(screen.getByText(/erased with them/)).toBeTruthy();
    const add = () => screen.getByRole("button", { name: "Add the note" });
    expect(add().hasAttribute("disabled")).toBe(true);
    typeIn("Add a note", "Called back on Tuesday");
    fireEvent.click(add());
    await waitFor(() => expect(mocks.actions.addProspectNoteAction).toHaveBeenCalledWith(ID, "Called back on Tuesday"));
    await waitFor(() => expect((screen.getByLabelText("Add a note") as HTMLTextAreaElement).value).toBe(""));
  });

  it("marks a consultation as held, and reopens a blocked prospect, with no question asked (both are reversible and recorded)", async () => {
    mocks.actions.consultationDoneAction.mockResolvedValue(ok());
    controls();
    press("Consultation held");
    await waitFor(() => expect(mocks.actions.consultationDoneAction).toHaveBeenCalledWith(ID));
    cleanup();
    mocks.actions.reopenProspectAction.mockResolvedValue(ok({ status: "active" }));
    controls({}, { status: "blocked", access: "blocked" });
    press("Reopen");
    await waitFor(() => expect(mocks.actions.reopenProspectAction).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Reopened."));
  });

  it("offers nothing at all when nothing can be done", () => {
    const { container } = controls({ actions: availableActions(facts({ erased: true, access: "erased" }), { view: true, manage: true }) });
    expect(container.textContent).toBe("");
  });
});

describe("making a client", () => {
  async function createClient(result: unknown) {
    mocks.actions.convertProspectAction.mockResolvedValue(result);
    controls();
    press("Make a client");
    const d = dialog("Make this prospect a client");
    expect(d.textContent).toContain("The prospect's conversation is not copied into it.");
    expect((within(d).getByLabelText("Workspace name") as HTMLInputElement).value).toBe("Pat's Roofing");
    expect((within(d).getByLabelText("Owner's email") as HTMLInputElement).value).toBe("pat@example.test");
    fireEvent.change(within(d).getByLabelText("Time zone"), { target: { value: "Asia/Manila" } });
    fireEvent.click(within(d).getByRole("button", { name: "Create the client" }));
    await waitFor(() => expect(mocks.actions.convertProspectAction).toHaveBeenCalledTimes(1));
    return d;
  }

  it("asks for a name and an owner's address first, and sends what was chosen", async () => {
    await createClient(ok({ orgId: "org-1", emailStatus: "sent", emailError: null, inviteLink: null }));
    expect(mocks.actions.convertProspectAction).toHaveBeenCalledWith(ID, { name: "Pat's Roofing", ownerEmail: "pat@example.test", timezone: "Asia/Manila" });
  });

  it("will not create without a name or an address", () => {
    controls();
    press("Make a client");
    const d = dialog("Make this prospect a client");
    fireEvent.change(within(d).getByLabelText("Workspace name"), { target: { value: "  " } });
    expect(within(d).getByRole("button", { name: "Create the client" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(d).getByLabelText("Workspace name"), { target: { value: "Pat's Roofing" } });
    fireEvent.change(within(d).getByLabelText("Owner's email"), { target: { value: "" } });
    expect(within(d).getByRole("button", { name: "Create the client" }).hasAttribute("disabled")).toBe(true);
  });

  it("says the invitation was sent, shows no link, and opens the new client", async () => {
    const d = await createClient(ok({ orgId: "org-1", emailStatus: "sent", emailError: null, inviteLink: null }));
    await within(d).findByText("Invitation sent");
    expect(within(d).queryByLabelText("Invitation link")).toBeNull();
    expect(d.textContent).not.toMatch(/https?:\/\//);
    fireEvent.click(within(d).getByRole("button", { name: "Open the client" }));
    expect(mocks.push).toHaveBeenCalledWith("/admin/clients/org-1");
  });

  it("gives the link to the person pressing only because the email did not go, and says so", async () => {
    const d = await createClient(ok({ orgId: "org-2", emailStatus: "failed", emailError: "mailbox full", inviteLink: "https://app.example.test/invite/abc" }));
    await within(d).findByText("Email failed to send");
    expect(d.textContent).toContain("mailbox full");
    const link = within(d).getByLabelText("Invitation link") as HTMLInputElement;
    expect(link.readOnly).toBe(true);
    expect(link.value).toBe("https://app.example.test/invite/abc");
    expect(d.textContent).toContain("It works once.");
  });

  it("shows the server's sentence and creates nothing when it is refused", async () => {
    mocks.actions.convertProspectAction.mockResolvedValue(fail("This prospect is already a client.", "conflict"));
    controls();
    press("Make a client");
    const d = dialog("Make this prospect a client");
    fireEvent.click(within(d).getByRole("button", { name: "Create the client" }));
    await within(d).findByText("This prospect is already a client.");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(within(d).queryByLabelText("Invitation link")).toBeNull();
  });
});

describe("taking their data away", () => {
  it("downloads what is held as a file named for nothing personal, and says the export was recorded", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), "blob:test"), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mocks.actions.exportProspectAction.mockResolvedValue(ok({ exportedAt: "2026-11-02T09:00:00.000Z", prospect: { name: "Pat" } }));
    controls();
    press("Export their data");
    await waitFor(() => expect(created).toHaveLength(1));
    expect(JSON.parse(await created[0].text())).toEqual({ exportedAt: "2026-11-02T09:00:00.000Z", prospect: { name: "Pat" } });
    expect(created[0].type).toBe("application/json");
    expect(click).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("The export was downloaded and recorded in the audit log.");
    click.mockRestore();
  });

  it("downloads nothing when the export is refused", async () => {
    const create = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    mocks.actions.exportProspectAction.mockResolvedValue(fail("This prospect's details were erased, so there is nothing to export."));
    controls();
    press("Export their data");
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The settings form
// ---------------------------------------------------------------------------

const SAVED = { ...DEMO_DEFAULTS, enabled: true };
function settings(over: Partial<React.ComponentProps<typeof DemoSettingsForm>> = {}) {
  return render(<DemoSettingsForm settings={SAVED} version={3} env={{ environment: true, emergencyStop: false }} canManage {...over} />);
}
const saveButton = () => screen.getByRole("button", { name: "Save the settings" });

describe("the settings form", () => {
  it("shows the saved values and cannot be saved until something changes", () => {
    settings();
    expect((screen.getByLabelText(/Hours a demo stays open/) as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText(/AI messages per demo/) as HTMLInputElement).value).toBe("10");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Discard my changes" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "36" } });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Discard my changes" })).toBeTruthy();
  });

  it("sends only what changed, with the version the screen was showing, and shows the saved values", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(ok({ version: 4, settings: { ...SAVED, windowHours: 36, dailyMessageCap: 100 } }));
    settings();
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "36" } });
    fireEvent.change(screen.getByLabelText(/AI messages per day, in all/), { target: { value: "100" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.actions.saveDemoSettingsAction).toHaveBeenCalledWith({ windowHours: 36, dailyMessageCap: 100 }, 3));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("The demo settings were saved."));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    // The next save carries the new version.
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "40" } });
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(ok({ version: 5, settings: { ...SAVED, windowHours: 40, dailyMessageCap: 100 } }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.actions.saveDemoSettingsAction).toHaveBeenLastCalledWith({ windowHours: 40 }, 4));
  });

  it("refuses a number outside its range before anything is sent, beside the field", () => {
    settings();
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText(/AI messages per demo/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Days conversations and details are kept/), { target: { value: "3" } });
    fireEvent.click(saveButton());
    expect(mocks.actions.saveDemoSettingsAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/from 1 to 168/);
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/from 7 to 730/);
    expect(screen.getByLabelText(/Hours a demo stays open/).getAttribute("aria-invalid")).toBe("true");
  });

  it("accepts only an https consultation link, and an empty one to show none", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(ok({ version: 4, settings: { ...SAVED, consultationUrl: "https://cal.example.test/intro" } }));
    settings();
    for (const bad of ["http://cal.example.test/intro", "javascript:alert(1)", "https://x", "cal.example.test"]) {
      fireEvent.change(screen.getByLabelText(/Consultation link/), { target: { value: bad } });
      fireEvent.click(saveButton());
      expect(mocks.actions.saveDemoSettingsAction, bad).not.toHaveBeenCalled();
      expect(screen.getByText(/must be a web address that starts with https/)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText(/Consultation link/), { target: { value: " https://cal.example.test/intro " } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.actions.saveDemoSettingsAction).toHaveBeenCalledWith({ consultationUrl: "https://cal.example.test/intro" }, 3));
  });

  it("reads blocked domains one per line, however they are separated or written, and sends a list only when it really changed", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(ok({ version: 4, settings: { ...SAVED, blockedEmailDomains: ["gmail.com", "yahoo.com"] } }));
    settings({ settings: { ...SAVED, blockedEmailDomains: ["gmail.com"] } });
    const box = screen.getByLabelText(/Email domains that cannot ask for a demo/);
    expect((box as HTMLTextAreaElement).value).toBe("gmail.com");
    // The same list, differently typed, is no change.
    fireEvent.change(box, { target: { value: "@Gmail.com, gmail.com" } });
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.change(box, { target: { value: "gmail.com\n@Yahoo.com" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.actions.saveDemoSettingsAction).toHaveBeenCalledWith({ blockedEmailDomains: ["gmail.com", "yahoo.com"] }, 3));
  });

  it("makes a person read a warning, and tick a box, before the AI chat is switched on, and sends nothing until they do", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(ok({ version: 4, settings: { ...SAVED, aiEnabled: true } }));
    settings();
    expect(screen.queryByText(/No real language model has been tested/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/The AI chat is on/));
    expect(screen.getByText(/No real language model has been tested with this chat/)).toBeTruthy();
    fireEvent.click(saveButton());
    expect(mocks.actions.saveDemoSettingsAction).not.toHaveBeenCalled();
    expect(screen.getByText("Tick the box to confirm you have read the warning.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I have read this and want the AI chat on/));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.actions.saveDemoSettingsAction).toHaveBeenCalledWith({ aiEnabled: true }, 3));
  });

  it("does not ask anything to switch the AI chat off", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(ok({ version: 4, settings: { ...SAVED, aiEnabled: false } }));
    settings({ settings: { ...SAVED, aiEnabled: true } });
    fireEvent.click(screen.getByLabelText(/The AI chat is on/));
    expect(screen.queryByText(/No real language model has been tested/)).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.actions.saveDemoSettingsAction).toHaveBeenCalledWith({ aiEnabled: false }, 3));
  });

  it("shows a stale screen's conflict, blocks saving, and offers a reload", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(fail("The settings were changed by someone else. Reload the page and look again before saving.", "conflict"));
    settings();
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "30" } });
    fireEvent.click(saveButton());
    const banner = await screen.findByText(/changed by someone else while you were looking at them/);
    expect(banner.closest('[role="alert"]')).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows any other refusal under the form and keeps what was typed", async () => {
    mocks.actions.saveDemoSettingsAction.mockResolvedValue(fail("Only a Super Admin can change the demo funnel.", "forbidden"));
    settings();
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "30" } });
    fireEvent.click(saveButton());
    await screen.findByText("Only a Super Admin can change the demo funnel.");
    expect((screen.getByLabelText(/Hours a demo stays open/) as HTMLInputElement).value).toBe("30");
  });

  it("puts everything back when changes are discarded", () => {
    settings();
    fireEvent.change(screen.getByLabelText(/Hours a demo stays open/), { target: { value: "30" } });
    fireEvent.click(screen.getByLabelText(/The demo is open to visitors/));
    fireEvent.click(screen.getByRole("button", { name: "Discard my changes" }));
    expect((screen.getByLabelText(/Hours a demo stays open/) as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText(/The demo is open to visitors/) as HTMLInputElement).checked).toBe(true);
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("is read-only for someone who may only view", () => {
    settings({ canManage: false });
    expect(screen.getByText("Only a Super Admin can change these settings. You can read them.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save the settings" })).toBeNull();
    for (const input of screen.getAllByRole("spinbutton")) expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/The demo is open to visitors/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Consultation link/) as HTMLInputElement).disabled).toBe(true);
  });

  it("says what visitors get right now from the saved switches, not from the unsaved ones", () => {
    settings({ env: { environment: false, emergencyStop: false } });
    expect(screen.getByRole("status").textContent).toContain("DEMO_ENABLED");
    fireEvent.click(screen.getByLabelText(/The demo is open to visitors/));
    expect(screen.getByRole("status").textContent).toContain("DEMO_ENABLED");
  });
});
