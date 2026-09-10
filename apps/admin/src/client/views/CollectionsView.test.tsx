import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { CollectionsView } from "./CollectionsView";

afterEach(cleanup);

const COLLECTIONS = [
  { id: "col1", name: "Week 1 readings", description: "Intro", documentCount: 2, directoryCount: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
];
const ATTACHMENTS = {
  attachments: [{ id: "a1", collectionId: "col1", scope: { kind: "homework", homeworkId: "hw1" } }],
};

function stubFetch(
  collections: typeof COLLECTIONS = COLLECTIONS,
  handlers: { onPost?: (body: unknown) => void; onDelete?: (url: string) => void } = {},
) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      handlers.onPost?.(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: "col2",
          name: "New",
          description: null,
          documentCount: 0,
          directoryCount: 0,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
        { status: 200 },
      );
    }
    if (init?.method === "DELETE") {
      handlers.onDelete?.(url);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/attachments")) return new Response(JSON.stringify(ATTACHMENTS), { status: 200 });
    return new Response(JSON.stringify({ collections }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("CollectionsView", () => {
  it("lists collections with their resolved counts", async () => {
    stubFetch();
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText("Week 1 readings"));
    expect(screen.getByText(/1 folder, 2 documents/i)).toBeTruthy();
  });

  it("shows where a collection is attached", async () => {
    stubFetch();
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText(/homework/i));
  });

  it("shows an empty state", async () => {
    stubFetch([]);
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText(/No collections yet/i));
  });

  it("opens a collection for editing", async () => {
    stubFetch();
    const onEditCollection = vi.fn();
    render(<CollectionsView courseId="c1" onEditCollection={onEditCollection} />);
    await waitFor(() => screen.getByText("Week 1 readings"));
    fireEvent.click(screen.getByText("Week 1 readings"));
    expect(onEditCollection).toHaveBeenCalledWith("col1");
  });

  it("reports a load failure distinctly from emptiness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText(/didn't load|went wrong/i));
    expect(screen.queryByText(/No collections yet/i)).toBeNull();
  });

  // --- Fix round 1: create and delete were unreachable -----------------------

  it("creates a new collection from the New collection form", async () => {
    const onPost = vi.fn();
    stubFetch(COLLECTIONS, { onPost });
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText("Week 1 readings"));

    fireEvent.click(screen.getByRole("button", { name: /new collection/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: "Week 2 readings" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create collection/i }));

    await waitFor(() =>
      expect(onPost).toHaveBeenCalledWith({ name: "Week 2 readings", description: null }),
    );
  });

  it("keeps Create disabled until a name is entered, since the API rejects an empty one", async () => {
    stubFetch();
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText("Week 1 readings"));

    fireEvent.click(screen.getByRole("button", { name: /new collection/i }));
    const createButton = screen.getByRole("button", { name: /create collection/i }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "  " } });
    expect(createButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Week 2" } });
    expect(createButton.disabled).toBe(false);
  });

  it("deletes a collection after confirming, naming what will be lost", async () => {
    const onDelete = vi.fn();
    stubFetch(COLLECTIONS, { onDelete });
    const confirmSpy = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", confirmSpy);
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText("Week 1 readings"));

    fireEvent.click(screen.getByRole("button", { name: /delete week 1 readings/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = String(confirmSpy.mock.calls[0]![0]);
    // What is being lost, not just "are you sure" -- the counts and the
    // homework attachment this collection currently backs.
    expect(message).toMatch(/1 folder/i);
    expect(message).toMatch(/2 documents/i);
    expect(message).toMatch(/homework/i);

    await waitFor(() =>
      expect(onDelete).toHaveBeenCalledWith("/api/courses/c1/knowledge/collections/col1"),
    );
  });

  it("does not delete when the confirmation is declined", async () => {
    const onDelete = vi.fn();
    stubFetch(COLLECTIONS, { onDelete });
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText("Week 1 readings"));

    fireEvent.click(screen.getByRole("button", { name: /delete week 1 readings/i }));

    expect(onDelete).not.toHaveBeenCalled();
  });
});
