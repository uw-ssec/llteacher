import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { CollectionEditView } from "./CollectionEditView";

afterEach(cleanup);

const DOCUMENTS = {
  documents: [
    { id: "d1", path: "week1/lecture", kind: "concept", type: "transcript", title: "Lecture 1", description: null, tags: null, indexStatus: "pending", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
    { id: "d2", path: "syllabus", kind: "concept", type: "syllabus", title: "Syllabus", description: null, tags: null, indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
  ],
};

function stubFetch(onPut?: (body: unknown) => void, documents: unknown = DOCUMENTS) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      onPut?.(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (String(input).includes("/documents")) {
      return new Response(JSON.stringify(documents), { status: 200 });
    }
    return new Response(
      JSON.stringify({ collections: [{ id: "col1", name: "Week 1", description: null, documentCount: 0, directoryCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("CollectionEditView", () => {
  it("offers every folder and document as a selectable item", async () => {
    stubFetch();
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/Syllabus/));
    expect(screen.getByLabelText(/week1/)).toBeTruthy();
  });

  it("sends a folder selection as a directoryPath item", async () => {
    const saved = vi.fn();
    stubFetch(saved);
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/week1/));

    fireEvent.click(screen.getByLabelText(/week1/));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ items: [{ directoryPath: "week1" }] }),
    );
  });

  it("sends a file selection as a documentId item", async () => {
    const saved = vi.fn();
    stubFetch(saved);
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/Syllabus/));

    fireEvent.click(screen.getByLabelText(/Syllabus/));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ items: [{ documentId: "d2" }] }));
  });

  it("counts documents not yet indexed so the instructor knows what is live", async () => {
    stubFetch();
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/week1/));

    fireEvent.click(screen.getByLabelText(/week1/));
    await waitFor(() => screen.getByText(/1 document.*1 not yet indexed/i));
  });

  // --- Beyond the brief -----------------------------------------------------

  it("does not let a folder selection pull in a sibling whose name it prefixes", async () => {
    // Guards the same hazard the repository layer pins with a week/weekend
    // test: selecting "week" must not resolve "weekend/b" too. If the UI ever
    // dropped the trailing slash from its prefix check, this would start
    // showing 2 documents instead of 1.
    const prefixDocuments = {
      documents: [
        { id: "d1", path: "week/a", kind: "concept", type: "n", title: "Week A", description: null, tags: null, indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
        { id: "d2", path: "weekend/b", kind: "concept", type: "n", title: "Weekend B", description: null, tags: null, indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
      ],
    };
    stubFetch(undefined, prefixDocuments);
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/^week$/));

    fireEvent.click(screen.getByLabelText(/^week$/));
    await waitFor(() => screen.getByText(/1 document/i));
    expect(screen.queryByText(/2 documents/i)).toBeNull();
    expect(screen.getByText("week/a")).toBeTruthy();
    expect(screen.queryByText("weekend/b")).toBeNull();
  });

  it("resolves to zero documents when nothing is selected", async () => {
    stubFetch();
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/Syllabus/));
    expect(screen.getByText(/0 documents/i)).toBeTruthy();
  });

  it("handles a bundle with no documents at all", async () => {
    stubFetch(undefined, { documents: [] });
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText(/0 documents/i));
    expect(screen.queryByLabelText(/week1/)).toBeNull();
  });

  it("reports a load failure distinctly from an empty knowledge base", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText(/didn't load|went wrong/i));
    expect(screen.queryByText(/0 documents/i)).toBeNull();
  });
});
