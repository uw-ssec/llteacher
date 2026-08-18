// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationView } from "./ConversationView";
import { readErrorMessage } from "./ConversationView";

beforeEach(() => {
  // jsdom doesn't implement these two DOM APIs Composer/ConversationView
  // call unconditionally (field-sizing feature detection, scroll-to-latest)
  // -- stubbed so mounting doesn't throw on unrelated missing browser APIs.
  vi.stubGlobal("CSS", { supports: () => true });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

// #270: aria-disabled + readOnly, not native `disabled` -- see Composer.tsx's
// own comment on the textarea for why (native disabled drops the element
// from the focus order the instant it's set, which blurs a focused
// composer with nothing to restore it).
function isComposerDisabled(el: HTMLTextAreaElement): boolean {
  return el.getAttribute("aria-disabled") === "true" && el.readOnly;
}

/* #144: Composer's `disabled` prop must actually be wired to the owning
   useChat's status via ConversationView's `isSending` -- previously it was
   never passed at all, so pressing Enter mid-stream could fire a second,
   overlapping `sendMessage` call. */
describe("ConversationView isSending (#144)", () => {
  it("leaves the composer enabled by default (isSending omitted)", async () => {
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />);
    const composer = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    expect(isComposerDisabled(composer)).toBe(false);
  });

  it("disables the composer while isSending is true, and re-enables it once false", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />,
    );
    expect(isComposerDisabled(screen.getByLabelText("Message input") as HTMLTextAreaElement)).toBe(true);

    rerender(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} />,
    );
    expect(isComposerDisabled(screen.getByLabelText("Message input") as HTMLTextAreaElement)).toBe(false);
  });

  it("does not call onSendMessage when Enter is pressed while isSending (composer is disabled)", async () => {
    const onSendMessage = vi.fn();
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={onSendMessage} isSending={true} />,
    );
    const composer = screen.getByLabelText("Message input");
    const user = userEvent.setup();
    // readOnly textareas reject typed input entirely -- confirms the guard
    // is actually load-bearing, not just cosmetic.
    await user.type(composer, "hello{Enter}");
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  // #270: this is the actual regression -- native `disabled` blurs a
  // focused element to document.body the instant it's set, with nothing to
  // restore it once re-enabled, forcing a keyboard-only student to
  // re-traverse the whole page (nav, sidebar, tutor rail, every
  // conversation row) to send their next message. aria-disabled+readOnly
  // never removes the element from the focus order in the first place, so
  // there's nothing to lose and nothing to restore.
  it("keeps focus on the composer across a full isSending true->false cycle", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} />,
    );
    const composer = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    composer.focus();
    expect(document.activeElement).toBe(composer);

    rerender(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />);
    // Still focused -- not blurred to document.body the way native
    // `disabled` would have done.
    expect(document.activeElement).toBe(composer);

    rerender(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} />);
    expect(document.activeElement).toBe(composer);
  });
});

/* #144: a failed/errored useChat turn must surface an inline, retryable
   error row instead of the response just silently disappearing. */
describe("ConversationView error row (#144)", () => {
  it("renders nothing extra when error is null/omitted", () => {
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the error message and a Retry action that calls onRetry when error is set", async () => {
    const onRetry = vi.fn();
    render(
      <ConversationView
        breadcrumb="b"
        messages={[]}
        onSendMessage={() => {}}
        error={{ message: "The response failed. Please try again.", onRetry }}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("The response failed. Please try again.")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// #280: the messages route pages at 200 with no "load older" wired -- this
// makes that ceiling visible instead of silent.
describe("ConversationView hasMoreHistory notice (#280)", () => {
  it("renders nothing extra when hasMoreHistory is omitted/false", () => {
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />);
    expect(screen.queryByText(/older messages aren't shown yet/i)).toBeNull();
  });

  it("renders a notice above the transcript when hasMoreHistory is true", () => {
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} hasMoreHistory={true} />,
    );
    expect(screen.getByText(/older messages aren't shown yet/i)).toBeTruthy();
  });
});

// #300: the transcript itself carries the live region -- role="log" is the
// role specified for a sequential-append list (vs. status/alert for a
// single replaceable message), and aria-relevant="additions" means only a
// newly-appended node is announced, not every text mutation inside an
// existing one (which is what the in-progress aria-busy message on
// Message.tsx suppresses -- see that component's own #300 test).
describe("ConversationView live region (#300)", () => {
  // #317 review, #327: role="log" moved from .conversation-inner (which
  // also held the breadcrumb/header-actions/title/hasMoreHistory notice --
  // none of that is turn content) to a narrower .conversation-log wrapper
  // around just the appended messages, so a header-row action (e.g. #248's
  // Restart button) is no longer announced as a log insertion the moment
  // it renders.
  it("marks the transcript as a polite, additions-only log region", () => {
    const { container } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />,
    );
    const log = container.querySelector(".conversation-log")!;
    expect(log.getAttribute("role")).toBe("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-relevant")).toBe("additions");
  });

  it("does NOT put aria-live on anything wider than .conversation-log (no torrent re-announce of every streamed token)", () => {
    const { container } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />,
    );
    // .conversation-inner is .conversation-log's own parent, and now also
    // holds the header row/title/notice -- the issue explicitly warns
    // against a live region wide enough to re-announce every streamed
    // token, so nothing above .conversation-log itself may carry aria-live.
    const inner = container.querySelector(".conversation-inner")!;
    expect(inner.getAttribute("aria-live")).toBeNull();
    const messagesWrap = container.querySelector(".conversation-messages")!;
    expect(messagesWrap.getAttribute("aria-live")).toBeNull();
  });

  // #317 review, #327: the header row (breadcrumb + any headerActions, e.g.
  // #248's Restart button) used to sit INSIDE the log region -- an eager
  // section greeting landing would announce Restart as a node ADDITION.
  it("renders the header row (breadcrumb + headerActions) outside the log region", () => {
    const { container } = render(
      <ConversationView
        breadcrumb="b"
        messages={[]}
        onSendMessage={() => {}}
        headerActions={<button>Restart section</button>}
      />,
    );
    const log = container.querySelector(".conversation-log")!;
    expect(log.querySelector(".conversation-header-row")).toBeNull();
    expect(screen.getByRole("button", { name: "Restart section" })).toBeTruthy();
  });

  // #317 review, #327: a role="status" that receives a deterministic
  // "the reply is done" signal on the streaming->idle transition, since
  // aria-busy's own replay behavior on completion is unspecified across AT.
  it("announces a deterministic status when isSending transitions from true to false", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />,
    );
    expect(screen.getByRole("status").textContent).toBe("");
    rerender(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/response complete/i);
  });
});

/* #248: the optional header-actions slot next to the breadcrumb -- e.g. the
   homework-section chat's "Restart section" button. Tutor chat passes
   nothing and must be unaffected. */
describe("ConversationView headerActions (#248)", () => {
  it("renders nothing extra when headerActions is omitted", () => {
    render(<ConversationView breadcrumb="STATS 311 · HW 3 · Section 3" messages={[]} onSendMessage={() => {}} />);
    expect(screen.queryByRole("button", { name: "Restart section" })).toBeNull();
  });

  it("renders the passed headerActions node alongside the breadcrumb", () => {
    render(
      <ConversationView
        breadcrumb="STATS 311 · HW 3 · Section 3"
        messages={[]}
        onSendMessage={() => {}}
        headerActions={<button>Restart section</button>}
      />,
    );
    expect(screen.getByText("STATS 311 · HW 3 · Section 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart section" })).toBeTruthy();
  });
});

/* #274: a Stop affordance for a turn that's merely slow, not yet timed out
   server-side -- only visible while a send is genuinely outstanding AND the
   caller actually tracks a useChat instance to stop. */
describe("ConversationView Stop control (#274)", () => {
  it("renders nothing when onStop is omitted, even while isSending", () => {
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  // #317 review, #327: Stop used to unmount the instant isSending flipped
  // false -- a keyboard user who just activated it had focus dropped to
  // document.body with nothing to restore it (the exact harm #270 already
  // fixed for the composer). It now stays mounted whenever onStop is set,
  // merely aria-disabled while nothing is in flight, so focus survives.
  it("stays mounted (aria-disabled, not removed) when onStop is set but isSending is false", () => {
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} onStop={() => {}} />,
    );
    const stopButton = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);
    expect(stopButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not call onStop when clicked while aria-disabled (isSending false)", async () => {
    const onStop = vi.fn();
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} onStop={onStop} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).not.toHaveBeenCalled();
  });

  it("renders Stop, not aria-disabled, and calls onStop when clicked, while isSending is true", async () => {
    const onStop = vi.fn();
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} onStop={onStop} />,
    );
    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton.getAttribute("aria-disabled")).toBeNull();
    const user = userEvent.setup();
    await user.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

/* readErrorMessage is the only branching logic in the stopped-state work and
   previously had no direct test. These pin the two properties that matter:
   the client never renders an unrecognized string as the student's message,
   and a non-retryable condition offers no retry. */
describe("readErrorMessage", () => {
  it("uses its own copy for a known code, never the server's prose", () => {
    const r = readErrorMessage(
      JSON.stringify({ error: "You're sending messages too quickly.", code: "rate_limited" }),
    );
    expect(r.label).toBe("Slow down");
    expect(r.message).toMatch(/wait a few seconds/i);
    expect(r.detail).toBeUndefined();
    expect(r.retryable).toBe(true);
  });

  it("does not offer retry when retrying provably cannot succeed", () => {
    for (const code of ["unauthorized", "history_too_long", "not_found", "denied", "unavailable"]) {
      const r = readErrorMessage(JSON.stringify({ error: "x", code }));
      expect(r.retryable).toBe(false);
    }
  });

  // #317 review, #344: "unavailable" is a server misconfiguration (a
  // missing/invalid LLM credential, no resolvable config) -- retrying
  // re-hits the exact same broken state every time, so offering one was a
  // false promise. The server's own reference-ID message is the one thing
  // an instructor can act on; it used to be hidden inside the collapsed
  // "Details for support" disclosure the `default` case uses.
  it("surfaces the server's own reference-ID message directly, not behind a details disclosure", () => {
    const r = readErrorMessage(
      JSON.stringify({
        error: "I'm sorry, but there's no valid LLM configuration available right now. Reference ID: abc-123",
        code: "unavailable",
      }),
    );
    expect(r.retryable).toBe(false);
    expect(r.message).toContain("Reference ID: abc-123");
    expect(r.detail).toBeUndefined();
  });

  it("falls back to generic 'unavailable' copy when the server sent no error text", () => {
    const r = readErrorMessage(JSON.stringify({ code: "unavailable" }));
    expect(r.retryable).toBe(false);
    expect(r.message).toMatch(/isn't available right now/i);
  });

  /* The defect this rewrite exists to fix: the previous version failed OPEN,
     promoting anything it did not recognize to the student's headline. */
  it.each([
    ['{"error":"OPENROUTER_API_KEY is not set. Run wrangler secret put"}', "OPENROUTER_API_KEY"],
    ['{"error":{"code":429,"message":"nested"}}', "429"],
    ['{"message":"wrong key"}', "wrong key"],
    ["Load failed", "Load failed"],
    ["ThrottlingException", "ThrottlingException"],
    ["<html><body>502 Bad Gateway</body></html>", "502"],
  ])("routes %s to the detail line, never the message", (raw, leaked) => {
    const r = readErrorMessage(raw);
    expect(r.message).not.toContain(leaked);
    expect(r.label).toBe("No response");
    // The load-bearing half: the machine text must actually be in `detail`.
    // Asserting only that `message` lacks it is vacuous, because `message`
    // is a literal on this branch and cannot contain input-derived text.
    expect(r.detail).toContain(leaked);
  });

  it("keeps the machine text available in the detail line", () => {
    expect(readErrorMessage("ThrottlingException").detail).toBe("ThrottlingException");
  });

  it("clamps an unbounded body so it cannot push the retry control away", () => {
    const r = readErrorMessage("x".repeat(5000));
    expect(r.detail!.length).toBeLessThanOrEqual(301);
    expect(r.detail!.endsWith("…")).toBe(true);
  });

  it("does not treat a quantity as a status code", () => {
    // The old regex matched `500` in "at most 500 entries" and told the
    // student to retry a deterministic 400.
    // Coded: the switch returns before any text is examined.
    const coded = readErrorMessage(
      JSON.stringify({ error: "messages must contain at most 500 entries", code: "history_too_long" }),
    );
    expect(coded.retryable).toBe(false);
    expect(coded.message).toMatch(/start a new one/i);

    // Uncoded: this is the path the old regex got wrong. No classification
    // happens on the text at all now, so the quantity cannot mislead it.
    const uncoded = readErrorMessage("Your essay must be at least 500 words");
    expect(uncoded.label).toBe("No response");
    expect(uncoded.detail).toBe("Your essay must be at least 500 words");
  });

  it("falls back to generic copy on empty or unparseable input", () => {
    for (const raw of ["", "   ", "{not json"]) {
      const r = readErrorMessage(raw);
      expect(r.label).toBe("No response");
      expect(r.message).toMatch(/didn't finish answering/i);
    }
  });
});

describe("stopped-state rendering", () => {
  const base = {
    breadcrumb: "STATS 311",
    messages: [],
    onSendMessage: vi.fn(),
  };

  /* The behavioural half of the retryable contract had no component test:
     withholding a button that provably cannot succeed is the point of the
     field, and nothing asserted it actually renders that way. */
  it("offers no retry when the failure cannot be retried", () => {
    render(
      <ConversationView
        {...base}
        error={{ message: JSON.stringify({ error: "Unauthorized", code: "unauthorized" }), onRetry: vi.fn() }}
      />,
    );
    expect(screen.getByText(/signed out/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers retry when it can succeed", () => {
    render(
      <ConversationView
        {...base}
        error={{ message: JSON.stringify({ error: "slow", code: "rate_limited" }), onRetry: vi.fn() }}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps the machine detail out of the alert region", () => {
    render(
      <ConversationView {...base} error={{ message: "ThrottlingException", onRetry: vi.fn() }} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("ThrottlingException");
    expect(screen.getByText("ThrottlingException")).toBeTruthy();
  });
});
