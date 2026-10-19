// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AqiMessageFeedback } from "@/components/aqi/message-feedback";
import { useMessageFeedback, type FeedbackMessage, type FeedbackValue } from "@/components/aqi/use-message-feedback";

vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => true,
}));

const fetchMock = vi.fn<typeof fetch>();
const ok = () => ({ ok: true }) as Response;
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Harness({ count = 1 }: { count?: number }) {
  const [visible, setVisible] = React.useState(true);
  const [messages, setMessages] = React.useState<FeedbackMessage[]>(() => Array.from({ length: count }, (_, i) => ({ id: "message-" + (i + 1), feedbackRating: null, feedbackComment: null })));
  const onChange = React.useCallback((id: string, value: FeedbackValue) => {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, feedbackRating: value.rating, feedbackComment: value.comment } : message));
  }, []);
  const feedback = useMessageFeedback(onChange);
  return <><button onClick={() => setVisible(!visible)}>Toggle panel</button>{visible && messages.map((message) => <section key={message.id} aria-label={message.id}>
    <AqiMessageFeedback message={message} status={feedback.statuses[message.id]} onChange={feedback.change} onRetry={feedback.retry} />
    <output aria-label={message.id + " saved details"}>{message.feedbackComment}</output>
  </section>)}</>;
}

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AQi immediate message feedback", () => {
  it("shows the like and acknowledgement before a slow database response, and lets the user undo it", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Helpful" }));
    expect(screen.getByRole("button", { name: "Remove helpful feedback" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Glad that helped!")).toBeTruthy();
    expect(screen.getByText("Saving feedback")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove helpful feedback" }));
    expect(screen.queryByText("Glad that helped!")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(ok()); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ messageId: "message-1", rating: 0 });
    await act(async () => { second.resolve(ok()); });
    expect(screen.getByRole("button", { name: "Helpful" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Saving feedback")).toBeNull();
  });

  it("records a dislike immediately and keeps it when optional details are skipped", async () => {
    fetchMock.mockResolvedValue(ok());
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    expect(screen.getByText("Thanks for telling us.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ messageId: "message-1", rating: -1 });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByLabelText("Feedback about this answer")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove not-helpful feedback" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.queryByText("Saving feedback")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid choices and does not roll back a newer dislike when an older like fails", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Helpful" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove helpful feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    await act(async () => { first.reject(new Error("offline")); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Thanks for telling us.")).toBeTruthy();
    expect(screen.queryByText("Couldn't save feedback.")).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).rating).toBe(-1);
    await act(async () => { second.resolve(ok()); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("restores the confirmed vote on failure and retries the intended vote immediately", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Helpful" }));
    await act(async () => { first.resolve({ ok: false } as Response); });
    expect(screen.getByText("Couldn't save feedback.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Helpful" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Retry feedback" }));
    expect(screen.getByText("Glad that helped!")).toBeTruthy();
    expect(screen.queryByText("Couldn't save feedback.")).toBeNull();
    await act(async () => { second.resolve(ok()); });
    expect(screen.queryByText("Saving feedback")).toBeNull();
  });

  it("saves different messages independently without locking the other controls", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness count={2} />);
    const one = within(screen.getByRole("region", { name: "message-1" }));
    const two = within(screen.getByRole("region", { name: "message-2" }));
    fireEvent.click(one.getByRole("button", { name: "Helpful" }));
    fireEvent.click(two.getByRole("button", { name: "Helpful" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve(ok()); first.resolve({ ok: false } as Response); });
    expect(one.getByText("Couldn't save feedback.")).toBeTruthy();
    expect(two.getByText("Glad that helped!")).toBeTruthy();
  });

  it("keeps the save and rollback alive while the chat panel is closed", async () => {
    const first = deferred();
    fetchMock.mockReturnValueOnce(first.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Helpful" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    await act(async () => { first.resolve({ ok: false } as Response); });
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    expect(screen.getByText("Couldn't save feedback.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Helpful" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("queues optional details behind a pending dislike and retains them for retry", async () => {
    const vote = deferred();
    const details = deferred();
    fetchMock.mockReturnValueOnce(vote.promise).mockReturnValueOnce(details.promise).mockResolvedValue(ok());
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    fireEvent.click(screen.getByRole("button", { name: "Incorrect information" }));
    fireEvent.change(screen.getByLabelText("Feedback about this answer"), { target: { value: "That setting has moved." } });
    fireEvent.click(screen.getByRole("button", { name: "Send details" }));
    expect(screen.getByLabelText("message-1 saved details").textContent).toBe("Incorrect information — That setting has moved.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vote.resolve(ok()); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toEqual({ messageId: "message-1", rating: -1, comment: "Incorrect information — That setting has moved." });
    await act(async () => { details.resolve({ ok: false } as Response); });
    expect(screen.getByRole("button", { name: "Remove not-helpful feedback" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Retry feedback" }));
    await waitFor(() => expect(screen.queryByText("Saving feedback")).toBeNull());
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(body);
  });
});
