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

function stubFetch(collections = COLLECTIONS) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
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
});
