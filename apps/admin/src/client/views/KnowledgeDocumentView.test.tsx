import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { KnowledgeDocumentView } from "./KnowledgeDocumentView";

afterEach(cleanup);

const DOCUMENT = {
  id: "d1",
  path: "week1/lecture",
  kind: "concept",
  type: "transcript",
  title: "Lecture 1",
  description: "Intro",
  tags: null,
  indexStatus: "pending",
  sourceMaterialId: "m1",
  updatedAt: "2026-09-01T00:00:00.000Z",
  body: "Welcome to lecture one. See [lab](/week1/lab/notes).",
  bodyOriginal: "Welcome to lecture one.",
  frontmatter: null,
  editedAt: null,
};

const LINKS = {
  outbound: [
    { rawHref: "/week1/lab/notes", targetPath: "week1/lab/notes", resolvedDocumentId: "d2", isBroken: false },
    { rawHref: "/gone", targetPath: "gone", resolvedDocumentId: null, isBroken: true },
  ],
  backlinks: [{ sourceDocumentId: "d3", sourcePath: "syllabus" }],
};

function stubFetch(onPut?: (body: unknown) => void) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      onPut?.(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ...DOCUMENT, body: "edited" }), { status: 200 });
    }
    if (url.endsWith("/links")) return new Response(JSON.stringify(LINKS), { status: 200 });
    return new Response(JSON.stringify(DOCUMENT), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The header keeps only the view toggle and Save visible; everything else
 *  is in the More menu. Opens it and returns the named item. */
function menuItem(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  return screen.getByRole("menuitem", { name });
}

describe("KnowledgeDocumentView", () => {
  it("renders the document's frontmatter and body", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByDisplayValue(/Welcome to lecture one/));
    expect(screen.getByText("week1/lecture")).toBeTruthy();
    expect(screen.getByText("transcript")).toBeTruthy();
  });

  it("flags a broken link rather than hiding it", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText("/gone"));
    expect(screen.getByText(/broken/i)).toBeTruthy();
  });

  it("lists backlinks", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText("syllabus"));
  });

  it("saves an edited body", async () => {
    const saved = vi.fn();
    stubFetch(saved);
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ body: "edited" }));
  });

  it("explains that saving updates the searchable document", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "changed" } });
    await waitFor(() => screen.getByText(/updates the searchable document/i));
  });

  it("reverts to the extracted text", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "mangled" } });
    fireEvent.click(menuItem(/restore original/i));

    await waitFor(() => expect(editor.value).toBe("Welcome to lecture one."));
  });

  it("toggles a rendered preview", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(screen.queryByLabelText(/document body/i)).toBeNull());
  });

  /* ------------------------------------------------------------------------
     Beyond the brief. See task-20-report.md for why each of these earns its
     place.
     ------------------------------------------------------------------------ */

  it("does not show the re-index warning, and disables Save, before anything is edited", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    expect(screen.queryByText(/updates the searchable document/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty("disabled", true);
  });

  it("has no revert control when the document was hand-authored (no extraction to revert to)", async () => {
    stubFetch();
    const hand = { ...DOCUMENT, bodyOriginal: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/links")) return new Response(JSON.stringify(LINKS), { status: 200 });
        return new Response(JSON.stringify(hand), { status: 200 });
      }),
    );
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: /restore original/i })).toBeNull();
  });

  it("keeps only the view toggle and Save in the header; the rest sits behind More", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clean up Markdown" })).toBeNull();
    expect(screen.queryByRole("button", { name: /restore original/i })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });

  it("marks unsaved changes with a status word in the header", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    fireEvent.change(editor, { target: { value: "edited" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("offers the Markdown and the original upload as downloads in the menu", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    const md = menuItem(/^Markdown/) as HTMLAnchorElement;
    expect(md.getAttribute("href")).toBe("/api/courses/c1/knowledge/documents/week1%2Flecture/download");
    expect(md.getAttribute("download")).toBe("lecture.md");
    const original = screen.getByRole("menuitem", { name: /^Original upload/ }) as HTMLAnchorElement;
    expect(original.getAttribute("href")).toBe("/api/courses/c1/materials/m1/download");
  });

  it("omits the original-upload download for a hand-authored document", async () => {
    const hand = { ...DOCUMENT, sourceMaterialId: null, bodyOriginal: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/links")) return new Response(JSON.stringify(LINKS), { status: 200 });
        return new Response(JSON.stringify(hand), { status: 200 });
      }),
    );
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    expect(menuItem(/^Markdown/)).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Original upload/ })).toBeNull();
  });

  it("clears the re-index warning once a save actually succeeds, rather than leaving it stuck on", async () => {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { body: string };
        // The server echoes back exactly what was saved, as a real PUT would.
        return new Response(JSON.stringify({ ...DOCUMENT, body: body.body }), { status: 200 });
      }
      if (url.endsWith("/links")) return new Response(JSON.stringify(LINKS), { status: 200 });
      return new Response(JSON.stringify(DOCUMENT), { status: 200 });
    });
    vi.stubGlobal("fetch", mock);

    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "a fresh edit" } });
    await waitFor(() => screen.getByText(/updates the searchable document/i));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.queryByText(/updates the searchable document/i)).toBeNull());
  });

  it("reports a failed save without discarding the instructor's edit", async () => {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
      if (url.endsWith("/links")) return new Response(JSON.stringify(LINKS), { status: 200 });
      return new Response(JSON.stringify(DOCUMENT), { status: 200 });
    });
    vi.stubGlobal("fetch", mock);

    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    await waitFor(() => expect(editor.value).toBe(DOCUMENT.body));
    fireEvent.change(editor, { target: { value: "do not lose me" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => screen.getByRole("alert"));
    // The edit is still there, and the view still considers it unsaved.
    expect(editor.value).toBe("do not lose me");
    expect(screen.getByText(/updates the searchable document/i)).toBeTruthy();
  });

  it("shows an empty body and 'no links' states without crashing", async () => {
    const empty = { ...DOCUMENT, body: "", bodyOriginal: null };
    const noLinks = { outbound: [], backlinks: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/links")) return new Response(JSON.stringify(noLinks), { status: 200 });
        return new Response(JSON.stringify(empty), { status: 200 });
      }),
    );
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    await waitFor(() => screen.getByText(/no outbound links/i));
    expect(screen.getByText(/nothing links here yet/i)).toBeTruthy();
  });

  it("reports a links-load failure instead of rendering it as 'no links'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/links")) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        return new Response(JSON.stringify(DOCUMENT), { status: 200 });
      }),
    );
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText(/links couldn't be loaded/i));
    expect(screen.queryByText(/no outbound links/i)).toBeNull();
  });

  it("calls onBack from a keyboard-reachable control", async () => {
    stubFetch();
    const onBack = vi.fn();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={onBack} />);
    await screen.findByLabelText(/document body/i);
    fireEvent.click(screen.getByRole("button", { name: /knowledge base/i }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("Markdown cleanup review", () => {
  function cleanupFetch() {
    let saved = DOCUMENT.body;
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/cleanup")) return new Response(JSON.stringify({ body: "# Clean lecture\n\nText", warnings: ["Check table columns"] }));
      if (String(input).endsWith("/links")) return new Response(JSON.stringify(LINKS));
      if (init?.method === "PUT") saved = JSON.parse(String(init.body)).body;
      return new Response(JSON.stringify({ ...DOCUMENT, body: saved }));
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }
  it("previews and discards without writing or losing the draft", async () => {
    const mock = cleanupFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = await screen.findByLabelText("Document body");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(DOCUMENT.body));
    fireEvent.change(editor, { target: { value: "Unsaved notes" } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await waitFor(() => expect((screen.getByRole("menuitem", { name: /^Clean up Markdown/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Clean up Markdown/ }));
    await screen.findByRole("region", { name: "Cleanup proposal" });
    expect(screen.getByText("Check table columns")).toBeTruthy();
    expect(mock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((screen.getByLabelText("Document body") as HTMLTextAreaElement).value).toBe("Unsaved notes");
  });
  it("applies with a saved-body precondition and refreshes the document", async () => {
    const mock = cleanupFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText("Document body");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await waitFor(() => expect((screen.getByRole("menuitem", { name: /^Clean up Markdown/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Clean up Markdown/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply cleanup" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Cleanup proposal" })).toBeNull());
    const put = mock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ body: "# Clean lecture\n\nText", expectedBody: DOCUMENT.body });
    expect(screen.getByRole("heading", { name: "Clean lecture" })).toBeTruthy();
  });
  it("retains the proposal on a concurrent edit conflict", async () => {
    const mock = cleanupFetch();
    const impl = mock.getMockImplementation()!;
    mock.mockImplementation(async (input, init) => init?.method === "PUT" ? new Response(JSON.stringify({ error: "The document changed. Reload it before applying cleanup." }), { status: 409 }) : impl(input, init));
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText("Document body");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await waitFor(() => expect((screen.getByRole("menuitem", { name: /^Clean up Markdown/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Clean up Markdown/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply cleanup" }));
    await screen.findByText("The document changed. Reload it before applying cleanup.");
    expect(screen.getByRole("region", { name: "Cleanup proposal" })).toBeTruthy();
  });

  it("deletes the document with its upload after a modal confirmation, then goes back", async () => {
    const onBack = vi.fn();
    const fetchMock = stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={onBack} />);
    await screen.findByLabelText(/document body/i);
    fireEvent.click(menuItem(/Delete document/));
    const dialog = await screen.findByRole("dialog", { name: /Delete “Lecture 1”/ });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Also delete the original upload/ })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    const del = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "DELETE");
    expect(String(del?.[0])).toBe("/api/courses/c1/knowledge/documents/week1%2Flecture?withUpload=1");
  });

  it("keeps the upload when the box is unticked, and cancels cleanly", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    fireEvent.click(menuItem(/Delete document/));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(menuItem(/Delete document/));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("checkbox", { name: /Also delete the original upload/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(true));
    const del = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "DELETE");
    expect(String(del?.[0])).toBe("/api/courses/c1/knowledge/documents/week1%2Flecture");
  });
});
