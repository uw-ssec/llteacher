// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResponseFeedback } from "./ResponseFeedback";

afterEach(cleanup);

// jsdom implements <dialog>.open toggling but not showModal()/close() --
// same stub AlertDialog.test.tsx (packages/ui) applies for the identical
// reason; ResponseFeedback renders a real AlertDialog under the hood.
function stubDialogMethods() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
stubDialogMethods();

const CONVERSATION_ID = "22222222-2222-2222-2222-222222222222";
const MESSAGE_ID = "33333333-3333-3333-3333-333333333333";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("ResponseFeedback (#90)", () => {
  it("renders a flag trigger button, closed by default", () => {
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    expect(screen.getByRole("button", { name: "Flag this response" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("opens the reason picker on click, with all four reasons and a comment field", async () => {
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByLabelText("Incorrect")).toBeTruthy();
    expect(screen.getByLabelText("Gave away the answer")).toBeTruthy();
    expect(screen.getByLabelText("Confusing")).toBeTruthy();
    expect(screen.getByLabelText("Other")).toBeTruthy();
    expect(screen.getByLabelText("Comment (optional)")).toBeTruthy();
  });

  it("cancelling closes the dialog and makes no request", async () => {
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a reason before submitting -- no request fires without one", async () => {
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose a reason before submitting.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits the selected reason and comment to the real endpoint, then shows the flagged state", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(201, { id: "flag-1", reason: "gave_away_answer", comment: "told me", flaggedAt: "2026-08-01T00:00:00.000Z" }),
    );
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByLabelText("Gave away the answer"));
    await user.type(screen.getByLabelText("Comment (optional)"), "told me");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `/api/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/feedback`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "gave_away_answer", comment: "told me" }),
      }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTitle("You flagged this response")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Flag this response" })).toBeNull();
  });

  // Important #2 (final-review fix): the "flagged" transition unmounts BOTH
  // the AlertDialog and the trigger button in the same commit -- the exact
  // defect class #298 closed for ErrorBoundary's fallback and App.tsx's
  // HomeworkLoadError, where a native <dialog>'s focus restoration targets
  // an element that no longer exists and focus falls to <body> instead.
  it("focuses the flagged confirmation (not <body>) after a successful flag", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(201, { id: "flag-1", reason: "confusing", flaggedAt: "2026-08-01T00:00:00.000Z" }),
    );
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByLabelText("Confusing"));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByTitle("You flagged this response")).toBeTruthy());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTitle("You flagged this response"));
  });

  it("treats a 409 already_flagged response the same as a fresh success", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(409, { error: "You've already flagged this response", code: "already_flagged" }));
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByLabelText("Confusing"));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByTitle("You flagged this response")).toBeTruthy());
  });

  it("shows a server-provided error message inline and keeps the dialog open on a genuine failure", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(400, { error: "reason is required" }));
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByLabelText("Other"));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("reason is required"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("shows a generic message when the request itself fails (network error)", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(<ResponseFeedback conversationId={CONVERSATION_ID} messageId={MESSAGE_ID} />);
    await user.click(screen.getByRole("button", { name: "Flag this response" }));
    await user.click(screen.getByLabelText("Incorrect"));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Something went wrong submitting this. Check your connection and try again.",
      ),
    );
  });
});
