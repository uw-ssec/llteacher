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

  it("warns that saving re-queues indexing", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "changed" } });
    await waitFor(() => screen.getByText(/re-indexed/i));
  });

  it("reverts to the extracted text", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "mangled" } });
    fireEvent.click(screen.getByRole("button", { name: /revert to extraction/i }));

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
    expect(screen.queryByText(/re-indexed/i)).toBeNull();
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
    expect(screen.queryByRole("button", { name: /revert to extraction/i })).toBeNull();
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
    await waitFor(() => screen.getByText(/re-indexed/i));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.queryByText(/re-indexed/i)).toBeNull());
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

    fireEvent.change(editor, { target: { value: "do not lose me" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => screen.getByRole("alert"));
    // The edit is still there, and the view still considers it unsaved.
    expect(editor.value).toBe("do not lose me");
    expect(screen.getByText(/re-indexed/i)).toBeTruthy();
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
