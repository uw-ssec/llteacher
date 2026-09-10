import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { KnowledgeView } from "./KnowledgeView";

afterEach(cleanup);
// Belt-and-suspenders: if a fake-timer test's assertion throws before it
// reaches its own `vi.useRealTimers()`, real timers never get restored and
// every subsequent test's `waitFor` (which polls on real timers) hangs until
// its own timeout -- turning one clear failure into a wall of unrelated
// ones. Restoring here every time makes that impossible regardless of where
// a test fails.
afterEach(() => vi.useRealTimers());

const DOCUMENTS = [
  {
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
  },
  {
    id: "d2",
    path: "syllabus",
    kind: "concept",
    type: "syllabus",
    title: "Syllabus",
    description: null,
    tags: null,
    indexStatus: "indexed",
    sourceMaterialId: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

const MATERIALS = [
  {
    id: "m1",
    title: "lecture1",
    sourceType: "transcript",
    originalFilename: "lecture1.vtt",
    byteSize: 100,
    contentType: "text/vtt",
    status: "ready",
    errorDetail: null,
    uploadedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "m2",
    title: "paper",
    sourceType: "pdf",
    originalFilename: "paper.pdf",
    byteSize: 100,
    contentType: "application/pdf",
    status: "pending",
    errorDetail: "Text extraction for .pdf is not implemented yet (#40).",
    uploadedAt: "2026-09-01T00:00:00.000Z",
  },
];

function stubFetch(overrides: Record<string, unknown> = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/reingest")) {
      return new Response(JSON.stringify({ status: "pending", documentCreated: false }), {
        status: 200,
      });
    }
    if (url.includes("/knowledge/documents")) {
      return new Response(JSON.stringify(overrides.documents ?? { documents: DOCUMENTS }), {
        status: 200,
      });
    }
    if (url.includes("/materials")) {
      return new Response(JSON.stringify(overrides.materials ?? { materials: MATERIALS }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("KnowledgeView", () => {
  it("renders the directory tree derived from paths", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: /week1/ }));
    expect(screen.getByRole("button", { name: /Knowledge base/ })).toBeTruthy();
  });

  it("shows root documents first and switches on directory click", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    expect(screen.queryByText("Lecture 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /week1/ }));
    await waitFor(() => screen.getByText("Lecture 1"));
  });

  it("shows a pending material's error detail rather than claiming it is ready", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText(/not implemented yet/i));
  });

  it("shows an empty state for a course with no documents", async () => {
    stubFetch({ documents: { documents: [] }, materials: { materials: [] } });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText(/No documents yet/i));
  });

  it("rejects a disallowed file before uploading it", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    const bad = new File(["MZ"], "evil.exe", { type: "application/octet-stream" });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() => screen.getByText(/Unsupported file type/i));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/materials")).length).toBe(1);
  });

  // I-4 (final review): handleFile awaited the upload with no catch at all,
  // so a failed upload was an unhandled promise rejection with zero
  // user-visible signal -- the instructor saw the list "reload" with
  // nothing added and no explanation. Pre-fix, this test's own rejected
  // fetch would propagate out of the click handler unhandled and the
  // assertion below would never see admin-field-error text appear.
  it("reports an upload failure instead of leaving it invisible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/materials")) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        if (url.includes("/knowledge/documents")) {
          return new Response(JSON.stringify({ documents: DOCUMENTS }), { status: 200 });
        }
        if (url.includes("/materials")) {
          return new Response(JSON.stringify({ materials: MATERIALS }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    const good = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [good] } });

    await waitFor(() => expect(screen.getByText(/boom|could not upload/i)).toBeTruthy());
  });

  // I-4: same unhandled-rejection gap in the retry path. Pre-fix, this
  // rejected reingest call would propagate unhandled and the retry alert
  // this test looks for would never render.
  it("reports a retry failure instead of leaving it invisible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/reingest")) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        if (url.includes("/knowledge/documents")) {
          return new Response(JSON.stringify({ documents: DOCUMENTS }), { status: 200 });
        }
        if (url.includes("/materials")) {
          return new Response(JSON.stringify({ materials: MATERIALS }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    fireEvent.click(screen.getByLabelText(/Retry ingestion for paper\.pdf/));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("offers a retry only for materials that are not ready", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    // MATERIALS[1] is the pending PDF; MATERIALS[0] is the ready transcript.
    expect(screen.getByLabelText(/Retry ingestion for paper\.pdf/)).toBeTruthy();
    expect(screen.queryByLabelText(/Retry ingestion for lecture1\.vtt/)).toBeNull();
  });

  it("posts a reingest when retry is pressed", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    fireEvent.click(screen.getByLabelText(/Retry ingestion for paper\.pdf/));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) => String(u).endsWith("/materials/m2/reingest") && (i as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("opens a document when its row is clicked", async () => {
    stubFetch();
    const onOpenDocument = vi.fn();
    render(<KnowledgeView courseId="c1" onOpenDocument={onOpenDocument} />);
    await waitFor(() => screen.getByText("Syllabus"));

    fireEvent.click(screen.getByText("Syllabus"));
    expect(onOpenDocument).toHaveBeenCalledWith("d2");
  });

  it("surfaces a load failure instead of an empty bundle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Failed to load/i),
    );
  });

  it("renders a material with no original filename without crashing", async () => {
    stubFetch({
      materials: {
        materials: [
          {
            id: "m3",
            title: "untitled upload",
            sourceType: "other",
            originalFilename: null,
            byteSize: null,
            contentType: null,
            status: "pending",
            errorDetail: null,
            uploadedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("untitled upload"));
    expect(screen.getByLabelText(/Retry ingestion for untitled upload/)).toBeTruthy();
  });

  it("does not offer a retry for a material that is already ready", async () => {
    stubFetch({
      materials: {
        materials: [MATERIALS[0]],
      },
    });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("lecture1.vtt"));
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
  });

  it("accepts a file within the allowed extensions and size without a client-side error", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    const good = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [good] } });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/materials") && (i as RequestInit)?.method === "POST")).toBe(true),
    );
    expect(screen.queryByText(/Unsupported file type/i)).toBeNull();
  });

  it("stops polling once nothing is pending", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({
      materials: { materials: [{ ...MATERIALS[0], status: "ready" }] },
    });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(12_000);
    // Two initial loads (documents + materials) and nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // Beyond the brief: the negative case above proves polling stops when
  // idle, but not that it ever ran at all -- a `pending` check that always
  // evaluated false would pass that test too. This is the positive half.
  //
  // Advanced in 1s steps rather than one 12s jump: this environment's fake
  // timers only let one microtask "layer" of the fetch -> setState -> render
  // -> effect chain drain per advance call, so a single large jump under-
  // counts how many layers actually resolved. Stepping (matching how a real
  // clock would tick) is what lets the initial load, then the poll tick's
  // own reload, each actually land before the assertion runs.
  it("keeps polling while a material is pending", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({
      materials: { materials: [MATERIALS[1]] }, // status: "pending"
    });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // Two initial loads, plus at least one poll tick's reload of both.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    vi.useRealTimers();
  });

  // Beyond the brief: navigating away and back re-mounts this view fresh --
  // the folder selection must be restorable from outside, since it is no
  // longer purely internal state once App.tsx carries it across that gap.
  it("opens the folder passed in via initialDirectory rather than root", async () => {
    stubFetch({
      documents: {
        documents: [
          ...DOCUMENTS,
          { ...DOCUMENTS[0], id: "d3", path: "week2/lecture", title: "Lecture 2" },
        ],
      },
    });
    render(
      <KnowledgeView courseId="c1" initialDirectory="week1" onOpenDocument={vi.fn()} />,
    );
    await waitFor(() => screen.getByText("Lecture 1"));
    // Root-level and the other week's documents are not shown -- only
    // week1's -- confirming the tree opened on week1, not root.
    expect(screen.queryByText("Syllabus")).toBeNull();
    expect(screen.queryByText("Lecture 2")).toBeNull();
  });

  it("reports folder changes via onDirectoryChange as the instructor browses", async () => {
    const onDirectoryChange = vi.fn();
    stubFetch();
    render(
      <KnowledgeView courseId="c1" onOpenDocument={vi.fn()} onDirectoryChange={onDirectoryChange} />,
    );
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.click(screen.getByRole("button", { name: /week1/i }));
    expect(onDirectoryChange).toHaveBeenCalledWith("week1");
  });
});
