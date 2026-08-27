// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationView } from "./ConversationView";
import type { MessageData } from "./ConversationView";
import { readErrorMessage, formatDayLabel } from "./ConversationView";

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

/* #96: the send-half of a failed turn. A refused/undelivered send persisted
   nothing, so there is no turn to regenerate and the student's own words are
   what needs rescuing -- the caller omits onRetry and passes the text back
   through restoredDraft instead. */
describe("ConversationView send-failure recovery (#96)", () => {
  it("renders no Retry button when the error carries no onRetry", () => {
    render(
      <ConversationView
        breadcrumb="b"
        messages={[]}
        onSendMessage={() => {}}
        error={{ message: "Load failed", stage: "send" }}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("puts a restored draft back into the composer", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />,
    );
    const composer = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    expect(composer.value).toBe("");

    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[]}
        onSendMessage={() => {}}
        restoredDraft={{ text: "why is my p-value 0.03?" }}
      />,
    );
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).value).toBe(
      "why is my p-value 0.03?",
    );
  });

  it("restores the SAME text twice when it fails twice (keyed on identity, not value)", async () => {
    const onSendMessage = vi.fn();
    const firstFailure = { text: "same question" };
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={onSendMessage} restoredDraft={firstFailure} />,
    );
    const composer = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    expect(composer.value).toBe("same question");

    // The student sends it again (composer clears), and it fails again with
    // identical text. A value-keyed effect would see no change and silently
    // swallow the second restore -- the "my words vanished" bug twice over.
    const user = userEvent.setup();
    await user.type(composer, "{Enter}");
    expect(onSendMessage).toHaveBeenCalledWith("same question");
    expect(composer.value).toBe("");

    rerender(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={onSendMessage} restoredDraft={{ text: "same question" }} />,
    );
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).value).toBe("same question");
  });

  it("never overwrites a draft the student has already started", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />,
    );
    const composer = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "words I am still writing" } });

    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[]}
        onSendMessage={() => {}}
        restoredDraft={{ text: "something that failed to send" }}
      />,
    );
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).value).toBe(
      "words I am still writing",
    );
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
    // #317 review, #345: messages must actually change between the two
    // renders -- an unchanged array now means "isSending was true only
    // because of a hydration retry, no turn was sent" and correctly
    // suppresses the announcement (see the #345 guard's own test below).
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />,
    );
    expect(screen.getByRole("status").textContent).toBe("");
    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[{ id: "a1", role: "ai", content: "answer" }]}
        onSendMessage={() => {}}
        isSending={false}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/response complete/i);
  });

  // #317 review, #345: `isSending` folds together chatStatus and a
  // hydration-retry flag in App.tsx -- an unchanged `messages` array across
  // the isSending true->false edge means no chat turn was actually sent,
  // so announcing "Response complete" would be false.
  it("does not announce completion when isSending clears with no message ever added (hydration retry, not a turn)", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />,
    );
    rerender(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  // #317 review, #345: the error alert already covers a failed turn --
  // announcing "Response complete" right alongside it, from the same
  // isSending edge a genuine success would use, contradicts it.
  it("does not announce completion when isSending clears with an error set", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />,
    );
    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[{ id: "u1", role: "student", content: "hi" }]}
        onSendMessage={() => {}}
        isSending={false}
        error={{ message: '{"error":"x","code":"unavailable"}', onRetry: () => {} }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("");
  });

  // #317 review, #345: Stop is the opposite of "complete" -- the previous
  // behavior told a student who pressed Stop that the reply had finished.
  it("announces that the response was stopped, not that it completed, when Stop was pressed", async () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} onStop={onStop} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[{ id: "u1", role: "student", content: "hi" }]}
        onSendMessage={() => {}}
        isSending={false}
        onStop={onStop}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/stopped/i);
    expect(screen.getByRole("status").textContent).not.toMatch(/complete/i);
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
   server-side -- only presented while a send is genuinely outstanding AND the
   caller actually tracks a useChat instance to stop. Since the #274 redesign
   it is the Stop identity of the composer's trailing action button, whose
   Send identity is covered here too. */
describe("ConversationView Stop control (#274)", () => {
  it("renders nothing when onStop is omitted, even while isSending", () => {
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  // #317 review, #327: Stop used to unmount the instant isSending flipped
  // false -- a keyboard user who just activated it had focus dropped to
  // document.body with nothing to restore it (the exact harm #270 already
  // fixed for the composer). #327 patched that by keeping a dedicated Stop
  // button permanently mounted and merely aria-disabled.
  //
  // #274 redesign makes the same guarantee structural instead: Stop and Send
  // are two identities of ONE never-unmounted button in the composer, so the
  // focused node survives the transition by construction rather than by a
  // disabled-state workaround. Asserting on node identity tests the actual
  // guarantee -- that the element the user is focused on is not destroyed --
  // which the old "is it still present and aria-disabled" check only proxied.
  it("keeps the very same button element across the streaming boundary, renaming Stop to Send", () => {
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={true} onStop={() => {}} />,
    );
    const during = screen.getByRole("button", { name: "Stop" });

    rerender(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} onStop={() => {}} />,
    );
    const after = screen.getByRole("button", { name: "Send" });

    expect(after).toBe(during);
    expect((after as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not call onStop when the trailing action is clicked with nothing in flight", async () => {
    const onStop = vi.fn();
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} isSending={false} onStop={onStop} />,
    );
    const user = userEvent.setup();
    // Not in its Stop identity at all here -- there is nothing to stop.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onStop).not.toHaveBeenCalled();
  });

  // #274 redesign: submission used to be Enter-only, so pointer and touch
  // users had no way to send a message at all. The trailing action closes
  // that gap, and shares submitDraft() with the Enter path so the two can
  // never drift on trimming or history-slot reset.
  it("sends the trimmed draft when the trailing Send action is clicked", async () => {
    const onSendMessage = vi.fn();
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={onSendMessage} />);
    const user = userEvent.setup();

    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await user.click(send);
    expect(onSendMessage).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Message input"), "  what is a sample space?  ");
    expect(send.getAttribute("aria-disabled")).toBeNull();
    await user.click(send);
    expect(onSendMessage).toHaveBeenCalledWith("what is a sample space?");
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
    for (const code of [
      "unauthorized",
      "history_too_long",
      "not_found",
      "denied",
      "unavailable",
      "duplicate_message",
    ]) {
      const r = readErrorMessage(JSON.stringify({ error: "x", code }));
      expect(r.retryable).toBe(false);
    }
  });

  /* #266: a reused clientMessageId carrying DIFFERENT content is refused
     with a 409, and that refusal is permanent -- the same id with the same
     different content fails identically forever. It used to share
     in_progress's code, so the student was told their message was "already
     on its way" (it was not; it was rejected and never persisted) and
     handed a Retry that could not succeed. Same defect, and same fix, as
     the section_closed carve-out above it. */
  it("treats a duplicate-message conflict as permanent, not as a send still in flight", () => {
    const dup = readErrorMessage(
      JSON.stringify({ error: "A message with this clientMessageId already exists with different content", code: "duplicate_message" }),
    );
    const inFlight = readErrorMessage(JSON.stringify({ error: "x", code: "in_progress" }));
    expect(dup.retryable).toBe(false);
    expect(inFlight.retryable).toBe(true);
    expect(dup.label).not.toBe(inFlight.label);
    expect(dup.message).not.toMatch(/on its way/i);
    /* The student must be told their message did not land -- the whole
       point of #266 is that it silently did not. */
    expect(dup.message).toMatch(/wasn't sent|not sent|didn't send/i);
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

  /* #96: the same raw string means two different things depending on which
     half of the turn died, and the single pre-#96 sentence ("the tutor didn't
     finish answering") was only ever true for one of them. */
  describe("failure stage (#96)", () => {
    it("defaults to the response half, preserving every pre-#96 caller's copy", () => {
      expect(readErrorMessage("Load failed")).toEqual(readErrorMessage("Load failed", "response"));
    });

    it("says the message never arrived, not that the tutor didn't answer, for a send-half failure", () => {
      const sent = readErrorMessage("Load failed", "send");
      expect(sent.label).toBe("Not sent");
      expect(sent.message).toMatch(/didn't reach the tutor/i);
      expect(sent.message).not.toMatch(/didn't finish answering/i);
      // The machine's words still go to the detail line, same as before.
      expect(sent.detail).toBe("Load failed");
    });

    it("never offers a retry on the send half, even for a code the response half treats as retryable", () => {
      const raw = JSON.stringify({ error: "too fast", code: "rate_limited" });
      // Same input, same classification -- only the recovery differs: there
      // is no server-side turn to regenerate, so the row must not offer one.
      expect(readErrorMessage(raw, "response").retryable).toBe(true);
      expect(readErrorMessage(raw, "send").retryable).toBe(false);
      expect(readErrorMessage(raw, "send").label).toBe("Slow down");
    });
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

// #80: the "Give me a hint" affordance -- forwarded through to Composer, so
// this covers ConversationView's own wiring (does the button appear only
// when onRequestHint is passed, does clicking it call through, does
// hintDisabled disable it) rather than re-testing Composer's own rendering.
describe("ConversationView onRequestHint (#80)", () => {
  it("renders no hint affordance when onRequestHint is not passed -- every existing caller unaffected", () => {
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} />);
    expect(screen.queryByRole("button", { name: /give me a hint/i })).toBeNull();
  });

  it("renders the hint button when onRequestHint is passed, and clicking it calls through", async () => {
    const onRequestHint = vi.fn();
    const user = userEvent.setup();
    render(<ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} onRequestHint={onRequestHint} />);

    const button = screen.getByRole("button", { name: "Give me a hint" });
    await user.click(button);
    expect(onRequestHint).toHaveBeenCalledTimes(1);
  });

  it("disables the hint button (but keeps it visible) when hintDisabled is true", () => {
    render(
      <ConversationView
        breadcrumb="b"
        messages={[]}
        onSendMessage={() => {}}
        onRequestHint={() => {}}
        hintDisabled={true}
      />,
    );
    const button = screen.getByRole("button", { name: /give me a hint/i });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("omits the hint affordance entirely when hideComposer is set, same as the composer itself", () => {
    render(
      <ConversationView breadcrumb="b" messages={[]} onSendMessage={() => {}} onRequestHint={() => {}} hideComposer />,
    );
    expect(screen.queryByRole("button", { name: /give me a hint/i })).toBeNull();
  });
});

/* --------------------------------------------------------------------------
   #278: the scroll effect used to key on the `messages` PROP, a brand-new
   array on every parent render, so it ran once per streamed token rather
   than once per new message -- forcing a synchronous layout of a subtree
   holding up to 200 hydrated nodes and restarting a smooth-scroll animation
   the browser never got to finish. These pin the dependency, not the effect
   body: each one fails if `messages.length` reverts to `messages`.
   -------------------------------------------------------------------------- */
describe("ConversationView scroll behaviour (#278)", () => {
  // "ai", not "assistant" -- MessageData's own role union (AIMessageData),
  // which is the design system's vocabulary rather than the wire format's.
  const msg = (id: string, content: string): MessageData => ({
    id,
    role: "ai",
    content,
  });

  function setReducedMotion(reduce: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  beforeEach(() => setReducedMotion(false));

  it("does not re-scroll when the same messages arrive as a new array identity", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    const first = [msg("m1", "hello")];
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={first} onSendMessage={() => {}} />,
    );
    const afterMount = scrollSpy.mock.calls.length;

    // Exactly what a parent re-render did on every streamed chunk: same
    // content, different array identity.
    rerender(
      <ConversationView breadcrumb="b" messages={[msg("m1", "hello")]} onSendMessage={() => {}} />,
    );

    expect(scrollSpy.mock.calls.length).toBe(afterMount);
  });

  it("does re-scroll when a message is genuinely added", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    const { rerender } = render(
      <ConversationView breadcrumb="b" messages={[msg("m1", "hello")]} onSendMessage={() => {}} />,
    );
    const afterMount = scrollSpy.mock.calls.length;

    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[msg("m1", "hello"), msg("m2", "there")]}
        onSendMessage={() => {}}
      />,
    );

    expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterMount);
  });

  it("uses smooth scrolling by default", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    render(<ConversationView breadcrumb="b" messages={[msg("m1", "a")]} onSendMessage={() => {}} />);
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("honours prefers-reduced-motion, which the global CSS rule cannot reach for a JS scroll", () => {
    setReducedMotion(true);
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    render(<ConversationView breadcrumb="b" messages={[msg("m1", "a")]} onSendMessage={() => {}} />);
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(scrollSpy).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("does not follow a streaming reply when reduced motion is set", () => {
    setReducedMotion(true);
    const { container, rerender } = render(
      <ConversationView
        breadcrumb="b"
        messages={[msg("m1", "partial")]}
        onSendMessage={() => {}}
        isSending={true}
      />,
    );
    const scroller = container.querySelector(".conversation-messages") as HTMLElement;
    // jsdom reports 0 for every layout metric, so isNearBottom() is
    // vacuously true -- any scrollTop write would be observable here.
    const written: number[] = [];
    Object.defineProperty(scroller, "scrollTop", {
      get: () => 0,
      set: (v: number) => written.push(v),
      configurable: true,
    });

    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[msg("m1", "partial and then some")]}
        onSendMessage={() => {}}
        isSending={true}
      />,
    );

    expect(written).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
   #288: disclosing the tutor's context window.

   The tutor forwards only a trailing window to the model while this
   component renders the full fetched history. Before this, nothing on
   screen distinguished "the tutor cannot see that turn" from "the tutor
   ignored me" -- chat.ts's own comment called the silent drop "a graceful
   degradation (the student can still reference them in the visible UI
   transcript)", and that parenthetical was exactly the bug.
   -------------------------------------------------------------------------- */
describe("ConversationView context window disclosure (#288)", () => {
  const msgs = (n: number): MessageData[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? "student" : "ai") as "student" | "ai",
      content: `message ${i}`,
    }));

  const boundary = () => document.querySelector(".conversation-context-boundary");

  it("draws no boundary when every message on screen is inside the window", () => {
    render(
      <ConversationView breadcrumb="b" messages={msgs(10)} onSendMessage={() => {}} contextWindowSize={40} />,
    );
    expect(boundary()).toBeNull();
  });

  it("draws no boundary at exactly the window size -- nothing has been dropped yet", () => {
    render(
      <ConversationView breadcrumb="b" messages={msgs(40)} onSendMessage={() => {}} contextWindowSize={40} />,
    );
    expect(boundary()).toBeNull();
  });

  it("draws the boundary once the transcript outgrows the window", () => {
    render(
      <ConversationView breadcrumb="b" messages={msgs(41)} onSendMessage={() => {}} contextWindowSize={40} />,
    );
    expect(boundary()).not.toBeNull();
    expect(screen.getByText(/memory starts here/i)).toBeTruthy();
  });

  it("places the boundary immediately above the oldest message still in context", () => {
    // 45 messages, window 40 -> the model sees m5..m44, so the line belongs
    // directly above m5. Asserting on POSITION, not just presence: a
    // boundary drawn in the wrong place is worse than none, because it
    // states a specific and false claim about what the tutor read.
    const { container } = render(
      <ConversationView breadcrumb="b" messages={msgs(45)} onSendMessage={() => {}} contextWindowSize={40} />,
    );
    const log = container.querySelector(".conversation-log")!;
    const children = Array.from(log.children);
    const boundaryIndex = children.findIndex((el) => el.classList.contains("conversation-context-boundary"));
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);

    // Everything before the line is out of context; the first thing after
    // it is the oldest message the tutor can see.
    const after = children[boundaryIndex + 1];
    expect(after?.textContent).toContain("message 5");
    const before = children[boundaryIndex - 1];
    expect(before?.textContent).toContain("message 4");
  });

  it("exposes the boundary as a labelled separator, not decoration", () => {
    render(
      <ConversationView breadcrumb="b" messages={msgs(41)} onSendMessage={() => {}} contextWindowSize={40} />,
    );
    const sep = screen.getByRole("separator", { name: /what the tutor can see/i });
    expect(sep).toBeTruthy();
  });

  it("draws nothing when no window is declared -- a read-only transcript forgets nothing", () => {
    // The instructor transcript viewer renders history with no model behind
    // it; claiming a memory boundary there would be false.
    render(<ConversationView breadcrumb="b" messages={msgs(500)} onSendMessage={() => {}} />);
    expect(boundary()).toBeNull();
  });

  it("still renders every message, in order, alongside the boundary", () => {
    // The disclosure must not become a truncation: the student keeps their
    // whole transcript, they are just told which part the tutor shares.
    const { container } = render(
      <ConversationView breadcrumb="b" messages={msgs(45)} onSendMessage={() => {}} contextWindowSize={40} />,
    );
    const log = container.querySelector(".conversation-log")!;
    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.getByText("message 44")).toBeTruthy();
    // 45 messages + 1 boundary
    expect(log.children.length).toBe(46);
  });
});

/* --------------------------------------------------------------------------
   #387: completion must not override a reader's scroll position.

   The follow-during-streaming effect correctly leaves a scrolled-up student
   alone. `isSending` was then a dependency of the length-keyed scroll
   effect, so the true->false transition at stream end scrolled to the
   bottom unconditionally -- undoing that protection at the one moment the
   student was most likely to still be reading.
   -------------------------------------------------------------------------- */
describe("ConversationView completion scroll (#387)", () => {
  const msg = (id: string, content: string): MessageData => ({ id, role: "ai", content });

  function setReducedMotion(reduce: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  /** jsdom reports 0 for every layout metric, so isNearBottom() is
   *  vacuously true by default. Overriding these is the only way to model a
   *  student who has scrolled away from the bottom. */
  function placeViewport(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: Record<string, number>) {
    Object.defineProperty(el, "scrollTop", { get: () => scrollTop, set: () => {}, configurable: true });
    Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { get: () => clientHeight, configurable: true });
  }

  beforeEach(() => setReducedMotion(false));

  it("leaves a scrolled-up reader where they are when the turn completes", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    const messages = [msg("m1", "a"), msg("m2", "b")];
    const { container, rerender } = render(
      <ConversationView breadcrumb="b" messages={messages} onSendMessage={() => {}} isSending={true} />,
    );
    const scroller = container.querySelector(".conversation-messages") as HTMLElement;
    // Far from the bottom: a deliberate scroll up to reread an earlier turn.
    placeViewport(scroller, { scrollTop: 0, scrollHeight: 5000, clientHeight: 500 });
    scrollSpy.mockClear();

    // Turn finishes. Same messages -- the reply was already rendered.
    rerender(
      <ConversationView breadcrumb="b" messages={messages} onSendMessage={() => {}} isSending={false} />,
    );

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("still settles at the bottom for a reader who never left it", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    const messages = [msg("m1", "a"), msg("m2", "b")];
    const { container, rerender } = render(
      <ConversationView breadcrumb="b" messages={messages} onSendMessage={() => {}} isSending={true} />,
    );
    const scroller = container.querySelector(".conversation-messages") as HTMLElement;
    placeViewport(scroller, { scrollTop: 4500, scrollHeight: 5000, clientHeight: 500 });
    scrollSpy.mockClear();

    rerender(
      <ConversationView breadcrumb="b" messages={messages} onSendMessage={() => {}} isSending={false} />,
    );

    expect(scrollSpy).toHaveBeenCalled();
  });

  it("still scrolls a scrolled-up reader for a genuinely new message", () => {
    // The unconditional triggers are deliberately kept: new content the
    // student has not seen, and the error row that carries the only
    // recovery control, must both reach the viewport.
    const scrollSpy = vi.fn();
    Element.prototype.scrollTo = scrollSpy as unknown as Element["scrollTo"];
    const { container, rerender } = render(
      <ConversationView breadcrumb="b" messages={[msg("m1", "a")]} onSendMessage={() => {}} />,
    );
    const scroller = container.querySelector(".conversation-messages") as HTMLElement;
    placeViewport(scroller, { scrollTop: 0, scrollHeight: 5000, clientHeight: 500 });
    scrollSpy.mockClear();

    rerender(
      <ConversationView
        breadcrumb="b"
        messages={[msg("m1", "a"), msg("m2", "b")]}
        onSendMessage={() => {}}
      />,
    );

    expect(scrollSpy).toHaveBeenCalled();
  });
});

/* #397: a tutoring conversation spans sittings. Before this, Monday's question
   and Wednesday's answer ran together with nothing between them. */
describe("ConversationView day separators (#397)", () => {
  const at = (iso: string) => iso;

  it("labels today, yesterday, a weekday inside the week, then a real date", () => {
    const now = new Date("2026-08-26T12:00:00");            // a Wednesday
    expect(formatDayLabel(at("2026-08-26T09:00:00"), now)).toBe("Today");
    expect(formatDayLabel(at("2026-08-25T09:00:00"), now)).toBe("Yesterday");
    // 4 days back is still unambiguous as a weekday.
    expect(formatDayLabel(at("2026-08-22T09:00:00"), now)).toBe("Saturday");
    /* 7 days back is NOT: "Wednesday" would name two different Wednesdays,
       which is worse than no label -- so it becomes an explicit date. */
    expect(formatDayLabel(at("2026-08-19T09:00:00"), now)).not.toMatch(/day$/);
    expect(formatDayLabel(at("2026-08-19T09:00:00"), now)).toMatch(/19/);
    // A different year carries the year; the same year does not.
    expect(formatDayLabel(at("2025-08-19T09:00:00"), now)).toMatch(/2025/);
    expect(formatDayLabel(at("2026-01-05T09:00:00"), now)).not.toMatch(/2026/);
  });

  it("returns empty for an unparseable date rather than 'Invalid Date'", () => {
    expect(formatDayLabel("not-a-date")).toBe("");
  });

  it("separates two calendar days and does not separate within one", () => {
    render(
      <ConversationView
        breadcrumb="b"
        onSendMessage={() => {}}
        messages={[
          { id: "a", role: "student", content: "mon q", createdAt: "2026-08-24T09:00:00" },
          { id: "b", role: "ai", content: "mon a", createdAt: "2026-08-24T09:01:00" },
          { id: "c", role: "student", content: "wed q", createdAt: "2026-08-26T09:00:00" },
        ]}
      />,
    );
    const seps = screen.getAllByRole("separator");
    // One before the first turn (a transcript opened days later says so at
    // the top), one at the boundary -- not one per message.
    expect(seps).toHaveLength(2);
    expect(seps[1]!.getAttribute("aria-label")).toBeTruthy();
  });

  it("does not let an undated turn break a day run", () => {
    /* A streaming reply, or a message the student has only just sent, has no
       persisted row and so no createdAt. It is always "now", so it must not
       be the thing that opens a new day. */
    render(
      <ConversationView
        breadcrumb="b"
        onSendMessage={() => {}}
        messages={[
          { id: "a", role: "student", content: "q", createdAt: "2026-08-26T09:00:00" },
          { id: "b", role: "ai", content: "streaming", isStreaming: true },
          { id: "c", role: "student", content: "q2", createdAt: "2026-08-26T09:05:00" },
        ]}
      />,
    );
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders no separator at all when nothing is dated", () => {
    render(
      <ConversationView
        breadcrumb="b"
        onSendMessage={() => {}}
        messages={[{ id: "a", role: "student", content: "q" }]}
      />,
    );
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

/* --------------------------------------------------------------------------
   #405 follow-on: making the rename hint visible to assistive technology
   put it inside the heading that wraps EditableTitle, so heading navigation
   announced the keybindings and character count as part of the conversation
   title. Naming the heading explicitly isolates it without re-hiding
   anything.
   -------------------------------------------------------------------------- */
describe("ConversationView header title naming", () => {
  it("names the heading with the conversation title alone, while editing", async () => {
    render(
      <ConversationView
        breadcrumb="b"
        title="Original title"
        onRenameTitle={async () => {}}
        messages={[]}
        onSendMessage={() => {}}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.getAttribute("aria-label")).toBe("Original title");

    // Enter rename mode -- the hint and counter now render inside this h1.
    await userEvent.click(screen.getByRole("button", { name: /Rename conversation/ }));
    expect(screen.getByText(/click away/i)).toBeTruthy();

    // The heading's name must still be the title, not the title plus its
    // own editing affordances.
    expect(screen.getByRole("heading", { level: 1, name: "Original title" })).toBeTruthy();
  });
});
