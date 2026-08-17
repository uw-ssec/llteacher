// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationView } from "./ConversationView";

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
    await user.click(screen.getByRole("button", { name: "Retry" }));
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
