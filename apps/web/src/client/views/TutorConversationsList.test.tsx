// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TutorConversationsList } from "./TutorConversationsList";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONV_A = {
  id: "conv-a",
  ownerUserId: "u1",
  courseId: "course-a",
  sectionId: null,
  kind: "tutor" as const,
  title: "Chat A",
  isDeleted: false,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  messageCount: 3,
};

function renderList(overrides: Partial<React.ComponentProps<typeof TutorConversationsList>> = {}) {
  const onSelectConversation = vi.fn();
  const onConversationCreated = vi.fn();
  const onToggleCollapse = vi.fn();
  const utils = render(
    <TutorConversationsList
      courseId="course-a"
      selectedConversationId={undefined}
      onSelectConversation={onSelectConversation}
      onConversationCreated={onConversationCreated}
      isCollapsed={false}
      onToggleCollapse={onToggleCollapse}
      {...overrides}
    />,
  );
  return { ...utils, onSelectConversation, onConversationCreated, onToggleCollapse };
}

describe("TutorConversationsList", () => {
  // Testing Strategy #2 ("Empty state renders when no conversations"):
  // catches broken layouts if the empty-state branch regresses.
  it("shows the empty state when GET /api/conversations returns []", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    renderList();
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
  });

  it("renders each conversation returned by the list fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([CONV_A]), { status: 200 })));
    renderList();
    expect(await screen.findByText("Chat A")).toBeTruthy();
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("surfaces a distinct error message (not the empty state) when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    renderList();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load/i);
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  // Testing Strategy #3 ("New conversation button creates and navigates"):
  // clicking New Conversation POSTs, the list updates, and the caller is
  // told to select/navigate to the created conversation.
  it("clicking New Conversation POSTs, prepends the result, and reports it as created", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") {
        expect(url).toBe("/api/conversations");
        expect(JSON.parse(String(init.body))).toEqual({ courseId: "course-a" });
        return new Response(JSON.stringify({ ...CONV_A, id: "conv-new", title: "New Conversation" }), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onConversationCreated } = renderList();
    await screen.findByText("No conversations yet");

    await userEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledWith("conv-new"));
    expect(await screen.findByText("New Conversation")).toBeTruthy();
  });

  it("disables New Conversation while courseId hasn't loaded yet", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderList({ courseId: undefined });
    const btn = (await screen.findByRole("button", { name: "New conversation" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // Testing Strategy #4 ("Conversation selection updates URL or state"):
  // clicking an existing row must report that row's id, not fire the
  // "created" callback used for new conversations.
  //
  // #6: the row itself (which the title is part of, per #4's original
  // contract restored after review) is the select control -- a small
  // pencil icon, not the title, is what enters rename mode instead (see
  // the "rename (#6)" describe block below). ConversationListItem.test.tsx
  // already covers the row/pencil split in isolation; this just confirms
  // TutorConversationsList wires onSelect through unchanged.
  it("clicking an existing conversation's row calls onSelectConversation with its id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([CONV_A]), { status: 200 })));
    const { onSelectConversation, onConversationCreated } = renderList();

    await userEvent.click(await screen.findByRole("button", { name: "Select conversation: Chat A" }));

    expect(onSelectConversation).toHaveBeenCalledWith("conv-a");
    expect(onConversationCreated).not.toHaveBeenCalled();
  });

  it("marks the selected conversation's select control as current", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([CONV_A]), { status: 200 })));
    renderList({ selectedConversationId: "conv-a" });
    const row = await screen.findByRole("button", { name: "Select conversation: Chat A" });
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  // Testing Strategy #5 ("Sidebar collapse state persists"): this component
  // doesn't own the localStorage write itself (App.tsx does, mirroring the
  // homework Sidebar's own division of labor -- Sidebar.tsx also just takes
  // isCollapsed/onToggleCollapse as props) -- verified here is that the
  // toggle button reflects isCollapsed and calls the callback, which is the
  // full contract this component is responsible for.
  it("collapse toggle reflects isCollapsed and calls onToggleCollapse when clicked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const { onToggleCollapse, rerender } = renderList({ isCollapsed: false });

    const expandedToggle = screen.getByRole("button", { name: "Collapse tutor conversations" });
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(expandedToggle);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    rerender(
      <TutorConversationsList
        courseId="course-a"
        selectedConversationId={undefined}
        onSelectConversation={() => {}}
        onConversationCreated={() => {}}
        isCollapsed
        onToggleCollapse={onToggleCollapse}
      />,
    );
    const collapsedToggle = screen.getByRole("button", { name: "Expand tutor conversations" });
    expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
  });

  // #6
  describe("rename", () => {
    it("clicking a row's title, then Enter, PATCHes that conversation and updates the row", async () => {
      const patchCalls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (init?.method === "PATCH") {
            patchCalls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ ...CONV_A, title: "Renamed chat" }), { status: 200 });
          }
          return new Response(JSON.stringify([CONV_A]), { status: 200 });
        }),
      );
      renderList();

      await userEvent.click(await screen.findByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Renamed chat{Enter}");

      expect(patchCalls).toEqual([{ url: "/api/conversations/conv-a", body: { title: "Renamed chat" } }]);
      expect(await screen.findByText("Renamed chat")).toBeTruthy();
    });

    it("reports the failed row's error inline and reverts its title when the PATCH fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            return new Response(JSON.stringify({ error: "Title already in use" }), { status: 400 });
          }
          return new Response(JSON.stringify([CONV_A]), { status: 200 });
        }),
      );
      renderList();

      await userEvent.click(await screen.findByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Attempted rename{Enter}");

      expect(await screen.findByRole("button", { name: "Rename: Chat A" })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toBe("Title already in use");
    });
  });

  // #6: these two callback props are how App.tsx's tutor chat header (a
  // sibling in App.tsx's JSX, not a descendant of this component) shares
  // this same hook instance's data/rename function -- see this file's own
  // TutorConversationsListProps doc comments for why.
  describe("header wiring (#6)", () => {
    it("reports the selected conversation via onSelectedConversationChange, including through a rename", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (init?.method === "PATCH") {
            return new Response(JSON.stringify({ ...CONV_A, title: "Renamed" }), { status: 200 });
          }
          if (url.startsWith("/api/conversations?")) {
            return new Response(JSON.stringify([CONV_A]), { status: 200 });
          }
          throw new Error(`unexpected fetch to ${url}`);
        }),
      );
      const onSelectedConversationChange = vi.fn();
      renderList({ selectedConversationId: "conv-a", onSelectedConversationChange });

      await waitFor(() =>
        expect(onSelectedConversationChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Chat A" })),
      );

      await userEvent.click(await screen.findByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Renamed{Enter}");

      await waitFor(() =>
        expect(onSelectedConversationChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Renamed" })),
      );
    });

    it("reports undefined via onSelectedConversationChange when nothing is selected", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([CONV_A]), { status: 200 })));
      const onSelectedConversationChange = vi.fn();
      renderList({ selectedConversationId: undefined, onSelectedConversationChange });

      await screen.findByText("Chat A");
      expect(onSelectedConversationChange).toHaveBeenCalledWith(undefined);
    });

    it("hands the parent a working renameConversation function via onRenameHandlerReady", async () => {
      const patchCalls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (init?.method === "PATCH") {
            patchCalls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ ...CONV_A, title: "From header" }), { status: 200 });
          }
          return new Response(JSON.stringify([CONV_A]), { status: 200 });
        }),
      );
      let handler: ((id: string, title: string) => Promise<unknown>) | undefined;
      renderList({ onRenameHandlerReady: (fn) => (handler = fn) });

      await screen.findByText("Chat A");
      await waitFor(() => expect(handler).toBeTruthy());

      await handler!("conv-a", "From header");

      expect(patchCalls).toEqual([{ url: "/api/conversations/conv-a", body: { title: "From header" } }]);
      // The list row itself reflects the header-initiated rename -- same
      // hook instance/state, not a second, drifting copy.
      expect(await screen.findByText("From header")).toBeTruthy();
    });
  });
});
