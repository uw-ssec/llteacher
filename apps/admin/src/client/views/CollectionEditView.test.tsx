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

/** `items` seeds GET .../items (defaults to an empty selection, matching a
 *  brand-new collection); `itemsStatus` lets a test make that load fail. */
function stubFetch(
  onPut?: (body: unknown) => void,
  documents: unknown = DOCUMENTS,
  items: unknown = { items: [] },
  itemsStatus = 200,
) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      onPut?.(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (url.includes("/items")) {
      return new Response(JSON.stringify(items), { status: itemsStatus });
    }
    if (url.includes("/documents")) {
      return new Response(JSON.stringify(documents), { status: 200 });
    }
    return new Response(JSON.stringify({ collections: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Waits out the (normally near-instant) items load and returns the Save
 *  button once it is actually clickable -- every test that saves goes
 *  through this rather than firing on the button the instant it renders, so
 *  a slow items response can never make a test pass by accident. */
async function saveButtonReady(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    if (button.disabled) throw new Error("Save is still disabled");
    return button;
  });
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
    fireEvent.click(await saveButtonReady());

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
    fireEvent.click(await saveButtonReady());

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

  // --- Fix round 1: loading and seeding the existing selection ---------------
  // Regression coverage for the data-loss bug: this view used to open with
  // nothing checked no matter what the collection already contained, and
  // saving from that blank slate silently wiped the rest via the wholesale
  // PUT. These pin GET .../items being loaded, used to seed the checkboxes,
  // and gating Save until it's known to have loaded successfully.

  it("seeds the picker from the collection's existing selection, folders and documents alike", async () => {
    stubFetch(undefined, DOCUMENTS, {
      items: [{ directoryPath: "week1" }, { documentId: "d2" }],
    });
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);

    const folderBox = (await screen.findByLabelText(/week1/)) as HTMLInputElement;
    const syllabusBox = (await screen.findByLabelText(/Syllabus/)) as HTMLInputElement;
    const lectureBox = (await screen.findByLabelText(/Lecture 1/)) as HTMLInputElement;

    await waitFor(() => expect(folderBox.checked).toBe(true));
    expect(syllabusBox.checked).toBe(true);
    // Covered only via the week1 folder, not selected as its own item -- the
    // checkbox reflects what was actually stored, not what the folder
    // happens to resolve to.
    expect(lectureBox.checked).toBe(false);
  });

  it("disables saving while the collection's current selection is still loading", async () => {
    let resolveItems!: (response: Response) => void;
    const pendingItems = new Promise<Response>((resolve) => {
      resolveItems = resolve;
    });
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      if (url.includes("/items")) return pendingItems;
      if (url.includes("/documents")) return new Response(JSON.stringify(DOCUMENTS), { status: 200 });
      return new Response(JSON.stringify({ collections: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", mock);

    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/week1/));

    const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText(/current selection/i)).toBeTruthy();

    // Let the request settle so the test doesn't leave a dangling promise.
    resolveItems(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await waitFor(() => expect(saveButton.disabled).toBe(false));
  });

  it("disables saving when the current selection fails to load, and says why", async () => {
    stubFetch(undefined, DOCUMENTS, { error: "boom" }, 500);
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/week1/));

    const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeTruthy());
    expect(saveButton.disabled).toBe(true);
  });

  it("preserves an untouched selection on save -- the regression test for the data-loss bug", async () => {
    const saved = vi.fn();
    stubFetch(saved, DOCUMENTS, { items: [{ directoryPath: "week1" }, { documentId: "d2" }] });
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);

    const folderBox = (await screen.findByLabelText(/week1/)) as HTMLInputElement;
    await waitFor(() => expect(folderBox.checked).toBe(true));

    // Nothing is clicked here -- the instructor opens the collection and
    // immediately saves (e.g. after only reading it). Before the fix, this
    // would PUT an empty item list and erase the collection.
    fireEvent.click(await saveButtonReady());

    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({
        items: [{ directoryPath: "week1" }, { documentId: "d2" }],
      }),
    );
  });

  // I-5 (final review): save() had try/finally but no catch, so a failed PUT
  // left the instructor on the page with the button back at "Save" and no
  // indication the collection's contents were not replaced. Pre-fix, the
  // rejected PUT below would propagate unhandled, onBack would never be
  // asserted against (correctly, since the save failed), but neither would
  // any alert appear -- this pins that a failure is now visible AND that the
  // view does not navigate away as if the save had succeeded.
  it("reports a save failure instead of leaving it invisible", async () => {
    const onBack = vi.fn();
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      if (url.includes("/items")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/documents")) return new Response(JSON.stringify(DOCUMENTS), { status: 200 });
      return new Response(JSON.stringify({ collections: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", mock);

    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={onBack} />);
    fireEvent.click(await saveButtonReady());

    await waitFor(() => expect(screen.getByText(/boom|could not save/i)).toBeTruthy());
    expect(onBack).not.toHaveBeenCalled();
    // The button must return to a clickable "Save", not stay stuck at
    // "Saving…" -- the instructor needs to be able to try again.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
  });
});
