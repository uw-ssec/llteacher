// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TutorConversationsList } from "./TutorConversationsList";
import type { ConversationListItemResponse } from "../../shared/types";

afterEach(cleanup);

const CONV_A: ConversationListItemResponse = {
  id: "conv-a",
  kind: "tutor",
  title: "Chat A",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  messageCount: 3,
};

// #223: presentational as of this fix -- conversations/loading/etc. all
// come from props (a single useTutorConversations instance App.tsx now
// owns and shares with the chat column's header) instead of this
// component fetching its own data. Tests inject props directly rather
// than mocking fetch.
function renderList(overrides: Partial<React.ComponentProps<typeof TutorConversationsList>> = {}) {
  const onSelectConversation = vi.fn();
  const onCreateConversation = vi.fn(async () => true);
  const onRenameConversation = vi.fn(async () => undefined);
  const onToggleCollapse = vi.fn();
  const onLoadMore = vi.fn();
  const utils = render(
    <TutorConversationsList
      courseId="course-a"
      courseContextLoading={false}
      conversations={[]}
      loading={false}
      loadError={false}
      awaitingCourseContext={false}
      onRetryLoad={() => {}}
      hasMore={false}
      onLoadMore={onLoadMore}
      loadingMore={false}
      loadMoreError={false}
      selectedConversationId={undefined}
      onSelectConversation={onSelectConversation}
      onCreateConversation={onCreateConversation}
      onRenameConversation={onRenameConversation}
      isCollapsed={false}
      onToggleCollapse={onToggleCollapse}
      {...overrides}
    />,
  );
  return { ...utils, onSelectConversation, onCreateConversation, onRenameConversation, onToggleCollapse, onLoadMore };
}

describe("TutorConversationsList", () => {
  it("shows the empty state when there are no conversations", () => {
    renderList();
    expect(screen.getByText(/Start one to ask about anything outside a section\./)).toBeTruthy();
  });

  it("renders each conversation it's given", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.getByText("Chat A")).toBeTruthy();
    expect(screen.queryByText(/Start one to ask about anything outside a section\./)).toBeNull();
  });

  it("surfaces a distinct error message (not the empty state) on loadError", () => {
    renderList({ loadError: true });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load/i);
    expect(screen.queryByText(/Start one to ask about anything outside a section\./)).toBeNull();
  });

  it("does not show the empty state while still loading", () => {
    renderList({ loading: true, conversations: [] });
    expect(screen.queryByText(/Start one to ask about anything outside a section\./)).toBeNull();
  });

  /* #280 (requirement 2): the load-more control that REPLACED the interim
     "older ones aren't shown yet" notice. `hasMore` now means "there is a
     next page to ask for", and going false is the honest end state --
     everything is on screen, so nothing is rendered. */
  describe("load more (#280)", () => {
    it("offers the load-more button when hasMore is true", () => {
      renderList({ conversations: [CONV_A], hasMore: true });
      expect(screen.getByRole("button", { name: /load older conversations/i })).toBeTruthy();
    });

    it("renders no load-more affordance when hasMore is false", () => {
      renderList({ conversations: [CONV_A], hasMore: false });
      expect(screen.queryByRole("button", { name: /load older conversations/i })).toBeNull();
    });

    it("does not offer load-more alongside loadError (Try again reloads from page 1 instead)", () => {
      renderList({ loadError: true, hasMore: true });
      expect(screen.queryByRole("button", { name: /load older conversations/i })).toBeNull();
    });

    it("clicking it calls onLoadMore", async () => {
      const { onLoadMore } = renderList({ conversations: [CONV_A], hasMore: true });
      await userEvent.click(screen.getByRole("button", { name: /load older conversations/i }));
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it("disables the button while a page is in flight", () => {
      renderList({ conversations: [CONV_A], hasMore: true, loadingMore: true });
      const btn = screen.getByRole("button", { name: /loading/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("surfaces a load-more failure without hiding the button (the page is still there to ask for)", () => {
      renderList({ conversations: [CONV_A], hasMore: true, loadMoreError: true });
      expect(screen.getByRole("button", { name: /load older conversations/i })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toMatch(/load older conversations/i);
    });
  });

  describe("create (#232/#235)", () => {
    it("clicking New Conversation calls onCreateConversation", async () => {
      const { onCreateConversation } = renderList();
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
      expect(onCreateConversation).toHaveBeenCalledTimes(1);
    });

    it("surfaces a visible, announced error when creation fails, reusing the alert element", async () => {
      const onCreateConversation = vi.fn(async () => false);
      renderList({ onCreateConversation });
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/couldn't create/i);
    });

    it("clears a prior create error once a later create succeeds", async () => {
      const onCreateConversation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      renderList({ onCreateConversation });
      const btn = screen.getByRole("button", { name: "New conversation" });
      await userEvent.click(btn);
      await screen.findByRole("alert");
      await userEvent.click(btn);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("disables New Conversation while courseId hasn't loaded yet, with a reason reachable via aria-describedby", () => {
      renderList({ courseId: undefined, courseContextLoading: true });
      const btn = screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      const describedById = btn.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      expect(document.getElementById(describedById!)?.textContent).toMatch(/loading/i);
    });

    it("gives a different disabled reason when there's genuinely no course, not just still loading", () => {
      renderList({ courseId: undefined, courseContextLoading: false });
      const btn = screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
      const describedById = btn.getAttribute("aria-describedby");
      expect(document.getElementById(describedById!)?.textContent).toMatch(/no course/i);
    });

    it("enables New Conversation once courseId is present", () => {
      renderList({ courseId: "course-a" });
      const btn = screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-describedby")).toBeNull();
    });
  });

  // #295: list-style: none strips list semantics in Safari/VoiceOver
  // without an explicit role="list" -- this rail took the "title becomes a
  // real button" alternative (not role="listbox"), so role="list" is the
  // one still required.
  it("marks the conversation rail as a list (#295)", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.getByRole("list", { name: "Tutor conversation list" })).toBeTruthy();
  });

  it("clicking an existing conversation's row calls onSelectConversation with its id", async () => {
    const { onSelectConversation } = renderList({ conversations: [CONV_A] });
    await userEvent.click(screen.getByRole("button", { name: "Select conversation: Chat A" }));
    expect(onSelectConversation).toHaveBeenCalledWith("conv-a");
  });

  it("marks the selected conversation's select control as current", () => {
    renderList({ conversations: [CONV_A], selectedConversationId: "conv-a" });
    const row = screen.getByRole("button", { name: "Select conversation: Chat A" });
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("collapse toggle reflects isCollapsed and calls onToggleCollapse when clicked", async () => {
    const { onToggleCollapse, rerender } = renderList({ isCollapsed: false });

    const expandedToggle = screen.getByRole("button", { name: "Collapse tutor conversations" });
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(expandedToggle);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    rerender(
      <TutorConversationsList
        courseId="course-a"
        courseContextLoading={false}
        conversations={[]}
        loading={false}
        loadError={false}
        awaitingCourseContext={false}
        onRetryLoad={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        loadingMore={false}
        loadMoreError={false}
        selectedConversationId={undefined}
        onSelectConversation={() => {}}
        onCreateConversation={async () => true}
        onRenameConversation={async () => undefined}
        isCollapsed
        onToggleCollapse={onToggleCollapse}
      />,
    );
    const collapsedToggle = screen.getByRole("button", { name: "Expand tutor conversations" });
    expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
  });

  describe("rename", () => {
    it("clicking a row's pencil, then Enter, calls onRenameConversation with the new title", async () => {
      const { onRenameConversation } = renderList({ conversations: [CONV_A] });

      await userEvent.click(screen.getByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Renamed chat{Enter}");

      expect(onRenameConversation).toHaveBeenCalledWith("conv-a", "Renamed chat");
    });

    it("reports the failed row's error inline when onRenameConversation rejects", async () => {
      const onRenameConversation = vi.fn(async () => {
        throw new Error("Title already in use");
      });
      renderList({ conversations: [CONV_A], onRenameConversation });

      await userEvent.click(screen.getByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Attempted rename{Enter}");

      expect(await screen.findByRole("button", { name: "Rename: Chat A" })).toBeTruthy();
      expect(screen.getByText("Title already in use")).toBeTruthy();
    });
  });
});

/* --------------------------------------------------------------------------
   #289: the delete affordance.

   DELETE /api/conversations/:id shipped ownership-checked, 404-on-not-owned
   and FK-safe, and no client code called it -- from the student's side the
   rail was append-only.
   -------------------------------------------------------------------------- */
describe("TutorConversationsList delete (#289)", () => {
  /* jsdom toggles <dialog>.open but does not implement showModal()/close().
     Same stub the design system's own AlertDialog.test.tsx uses -- copied
     rather than shared because it patches a global prototype, and a helper
     imported across package boundaries to do that would be a worse thing to
     own than four lines. The stubs flip `.open` the way a real browser
     would, since AlertDialog reads it back before acting. */
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };

  it("offers no delete affordance when the caller supplies no handler", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.queryByRole("button", { name: /^Delete conversation/ })).toBeNull();
  });

  it("names the conversation in the control, so rows are distinguishable", () => {
    renderList({ conversations: [CONV_A], onDeleteConversation: vi.fn(async () => true) });
    // "Delete" alone is identical across every row in a list.
    expect(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` })).toBeTruthy();
  });

  it("confirms before deleting, and does not delete on cancel", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    // Deletion is soft server-side but irreversible from this UI -- there is
    // no undo and no trash view, so one click must not be enough.
    expect(onDeleteConversation).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete this conversation\?/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDeleteConversation).not.toHaveBeenCalled();
  });

  it("deletes on confirm and announces it", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteConversation).toHaveBeenCalledWith(CONV_A.id);
    expect(await screen.findByText(`Deleted ${CONV_A.title}`)).toBeTruthy();
  });


  it("announces a delete failure as an alert, not a silent describedby swap", async () => {
    // Focus stays inside the open dialog while the request runs, and
    // swapping the text of an aria-describedby target is not reliably
    // announced -- the existing restart dialog already uses role="alert"
    // for its failure, and this now matches it.
    const onDeleteConversation = vi.fn(async () => false);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't delete that conversation/);
  });

  it("closes the dialog rather than unmounting it, so focus can be restored", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // The <dialog> element survives the cancel -- AlertDialog's controlled
    // close() path needs it mounted to run and hand focus back. Unmounting
    // an open native dialog drops focus to <body>.
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute("open")).toBe(false);
  });

  it("keeps the dialog open and says so when the delete fails", async () => {
    const onDeleteConversation = vi.fn(async () => false);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Closing on failure would leave the student unsure whether it happened,
    // and the row is still there.
    expect(await screen.findByText(/Couldn't delete that conversation/)).toBeTruthy();
    expect(screen.getByText(/has not been deleted/)).toBeTruthy();
  });
});

/* --------------------------------------------------------------------------
   #293 / #310 / #290 -- rail feedback and failure handling.

   Each of these pins a state the rail could previously reach and render
   misleadingly. They are written against the props, not the hook, because
   this component is presentational (#223) -- the hook's own half of #293 is
   covered in useTutorConversations.test.ts.
   -------------------------------------------------------------------------- */
describe("TutorConversationsList empty state and course context (#293)", () => {
  it("does not claim 'No conversations yet' before course context has arrived", () => {
    // The exact state the rail hit on EVERY page load for one round-trip:
    // not loading, no error, zero rows -- but only because courseId hadn't
    // resolved. A returning student with eight conversations was told their
    // work was gone.
    renderList({
      courseId: undefined,
      courseContextLoading: true,
      awaitingCourseContext: true,
      loading: false,
      conversations: [],
    });
    expect(screen.queryByText(/Start one to ask about/)).toBeNull();
  });

  it("still shows the empty state once course context exists and the list is genuinely empty", () => {
    renderList({ awaitingCourseContext: false, loading: false, conversations: [] });
    expect(screen.getByText(/Start one to ask about/)).toBeTruthy();
  });

  it("renders the disabled-button reason as visible text, not only sr-only/title", () => {
    renderList({ courseId: undefined, courseContextLoading: true, awaitingCourseContext: true });
    const reason = screen.getByText("Loading course information…");
    // The regression: this used to carry className="sr-only", so a sighted
    // student on a tablet -- no hover, so no title tooltip either -- got a
    // button that did nothing and said nothing.
    expect(reason.className).not.toContain("sr-only");
  });

  it("distinguishes 'still loading' from 'no course at all' in that visible reason", () => {
    renderList({ courseId: undefined, courseContextLoading: false, awaitingCourseContext: true });
    expect(screen.getByText(/No course selected yet/)).toBeTruthy();
  });
});

describe("TutorConversationsList load failure (#310)", () => {
  it("keeps showing the rows it already had when a refresh fails", () => {
    renderList({ loadError: true, conversations: [CONV_A] });
    // The rail no longer clears itself on a failed fetch, so the student's
    // conversations do not appear deleted by one 502 during a deploy.
    expect(screen.getByText(CONV_A.title)).toBeTruthy();
    expect(screen.getByText(/may be out of date/)).toBeTruthy();
  });

  it("offers a retry that calls back, rather than leaving the rail dead for the session", async () => {
    const onRetryLoad = vi.fn();
    renderList({ loadError: true, onRetryLoad });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it("says 'couldn't load' rather than 'out of date' when there is genuinely nothing to show", () => {
    renderList({ loadError: true, conversations: [] });
    expect(screen.getByText("Couldn't load conversations.")).toBeTruthy();
  });
});

describe("TutorConversationsList selection feedback (#290)", () => {
  it("does not mark a pending row aria-current -- only the settled one is current (#389)", () => {
    renderList({
      conversations: [CONV_A, { ...CONV_A, id: "conv-b", title: "Chat B" }],
      selectedConversationId: CONV_A.id,
      pendingConversationId: "conv-b",
    });
    // aria-current marks THE current item. Two at once contradicts the live
    // region, which correctly says one of them is still loading.
    expect(document.querySelectorAll('[aria-current="true"]').length).toBe(1);
    // ...and it is the one actually on screen, not the one loading.
    expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(CONV_A.title);
    // The pending row still reads as busy -- the click is still visibly
    // registered, which is what #290 was for.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("marks the pending row busy and selected while its history is in flight", () => {
    renderList({
      conversations: [CONV_A],
      selectedConversationId: undefined,
      pendingConversationId: CONV_A.id,
    });
    // Selection state used to derive entirely from the FETCHED result, so
    // the whole in-flight window looked identical to a dead control.
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy?.className).toContain("tutor-conversation-item--selected");
  });

  it("announces the in-flight selection, then the opened conversation", () => {
    const { rerender } = renderList({
      conversations: [CONV_A],
      pendingConversationId: CONV_A.id,
    });
    expect(screen.getByText(new RegExp(`Loading conversation ${CONV_A.title}`))).toBeTruthy();

    rerender(
      <TutorConversationsList
        courseId="course-a"
        courseContextLoading={false}
        conversations={[CONV_A]}
        loading={false}
        loadError={false}
        awaitingCourseContext={false}
        onRetryLoad={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        loadingMore={false}
        loadMoreError={false}
        selectedConversationId={CONV_A.id}
        pendingConversationId={undefined}
        onSelectConversation={() => {}}
        onCreateConversation={async () => true}
        onRenameConversation={async () => undefined}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(screen.getByText(`Opened ${CONV_A.title}`)).toBeTruthy();
  });

  it("leaves a settled selection un-busy", () => {
    renderList({
      conversations: [CONV_A],
      selectedConversationId: CONV_A.id,
      pendingConversationId: undefined,
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

/* --------------------------------------------------------------------------
   #398 / #399 / #400 -- defects found by a high-effort re-review of the
   fixes in this PR, not of the original code.
   -------------------------------------------------------------------------- */
describe("TutorConversationsList announcements and retry (#399, #400)", () => {
  it("still announces a rename after a conversation has been selected (#399)", async () => {
    const onRenameConversation = vi.fn(async () => undefined);
    renderList({
      conversations: [CONV_A],
      selectedConversationId: CONV_A.id,
      onRenameConversation,
    });

    // `selectionMessage ?? liveMessage` made "Opened X" permanent once
    // anything was selected, masking every later action announcement --
    // a regression of #235 inside the PR meant to improve this surface.
    await userEvent.click(screen.getByRole("button", { name: `Rename: ${CONV_A.title}` }));
    const input = screen.getByLabelText("Edit title");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed thing{Enter}");

    expect(await screen.findByText("Renamed to Renamed thing")).toBeTruthy();
  });

  it("still announces a create after a conversation has been selected (#399)", async () => {
    renderList({
      conversations: [CONV_A],
      selectedConversationId: CONV_A.id,
      onCreateConversation: vi.fn(async () => true),
    });
    await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByText("Conversation created")).toBeTruthy();
  });

  it("does not leave the live region stuck on Loading after a cancelled selection", async () => {
    // Found re-reviewing #399's own fix: splitting the announcement across
    // two effects left no writer for "pending ended without opening
    // anything" -- the student navigates to a homework section and the
    // region keeps saying "Loading conversation X…" indefinitely.
    const { rerender } = renderList({
      conversations: [CONV_A],
      pendingConversationId: CONV_A.id,
    });
    expect(screen.getByText(/Loading conversation/)).toBeTruthy();

    rerender(
      <TutorConversationsList
        courseId="course-a"
        courseContextLoading={false}
        conversations={[CONV_A]}
        loading={false}
        loadError={false}
        awaitingCourseContext={false}
        onRetryLoad={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        loadingMore={false}
        loadMoreError={false}
        selectedConversationId={undefined}
        pendingConversationId={undefined}
        onSelectConversation={() => {}}
        onCreateConversation={async () => true}
        onRenameConversation={async () => undefined}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />,
    );

    await waitFor(() => expect(screen.queryByText(/Loading conversation/)).toBeNull());
  });

  it("disables the retry while a load is in flight (#400)", () => {
    renderList({ loadError: true, loading: true });
    const retry = screen.getByRole("button", { name: /Retrying/ });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the retry again once the load settles (#400)", () => {
    renderList({ loadError: true, loading: false });
    const retry = screen.getByRole("button", { name: "Try again" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });
});
