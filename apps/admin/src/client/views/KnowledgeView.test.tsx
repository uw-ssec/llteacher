import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
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

  it("shows recent documents at rest and only the folder's own once one is selected", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    expect(screen.getByText(/Recently updated/)).toBeTruthy();
    expect(screen.getByText("Lecture 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /week1/ }));
    await waitFor(() => screen.getByText("Lecture 1"));
    expect(screen.queryByText("Syllabus")).toBeNull();
    // A breadcrumb names where the listing is.
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toMatch(/week1/);
  });

  it("puts the search field first and focuses it on load", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search the knowledge base" }));
  });

  it("replaces the overview with results while there is a query, and restores it on clear", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the knowledge base" }), { target: { value: "lect" } });
    expect(screen.queryByText(/Recently updated/)).toBeNull();
    expect(screen.getByRole("region", { name: "Search results" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText(/Recently updated/)).toBeTruthy();
  });

  it("runs the content search on Enter with the selected folder as scope", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.click(screen.getByRole("button", { name: /week1/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the knowledge base" }), { target: { value: "intro" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/knowledge/search?q=intro&dir=week1"))).toBe(true),
    );
  });

  it("reveals a folder from a result's path, selecting and expanding it", async () => {
    stubFetch();
    const onDirectoryChange = vi.fn();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} onDirectoryChange={onDirectoryChange} />);
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the knowledge base" }), { target: { value: "lecture" } });
    fireEvent.click(screen.getByRole("button", { name: /File names/ }));
    fireEvent.click(screen.getByRole("button", { name: "Show folder week1" }));
    expect(onDirectoryChange).toHaveBeenCalledWith("week1");
    const rail = within(screen.getByRole("navigation", { name: "Folders" }));
    expect(rail.getByRole("button", { name: /week1/ }).getAttribute("aria-current")).toBe("true");
  });

  it("names the last indexed time in the eyebrow instead of repeating the count", async () => {
    stubFetch({
      documents: { documents: [DOCUMENTS[0], { ...DOCUMENTS[1], updatedAt: "2026-09-17T14:05:00.000Z" }] },
    });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText(/Last indexed/));
    const eyebrow = screen.getByText(/Last indexed/);
    expect(eyebrow.textContent).toMatch(/Sep 17, 2026/);
    // The count lives in the status strip; the eyebrow must not repeat it.
    expect(eyebrow.textContent).not.toMatch(/documents/i);
  });

  it("filters the pane to pending uploads from the status strip", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.click(screen.getByRole("button", { name: /pending/ }));
    expect(screen.queryByText(/Recently updated/)).toBeNull();
    const list = screen.getByRole("list", { name: "Uploads needing attention" });
    expect(within(list).getByText("paper.pdf")).toBeTruthy();
    expect(within(list).queryByText("lecture1.vtt")).toBeNull();
  });

  it("retries every failed upload from one button", async () => {
    const fetchMock = stubFetch({
      materials: { materials: [
        { ...MATERIALS[1], id: "f1", originalFilename: "a.docx", status: "failed" },
        { ...MATERIALS[1], id: "f2", originalFilename: "b.docx", status: "failed" },
        MATERIALS[1],
      ] },
    });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("a.docx"));
    fireEvent.click(screen.getByRole("button", { name: "Retry all failed" }));
    await waitFor(() => {
      const reingests = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/reingest")).map(([u]) => String(u));
      expect(reingests).toEqual(["/api/courses/c1/materials/f1/reingest", "/api/courses/c1/materials/f2/reingest"]);
    });
  });

  it("restores expanded folders from initialExpanded and reports changes", async () => {
    stubFetch({
      documents: { documents: [...DOCUMENTS, { ...DOCUMENTS[0], id: "d3", path: "week1/lab/notes", title: "Lab notes" }] },
    });
    const onExpandedChange = vi.fn();
    render(
      <KnowledgeView courseId="c1" onOpenDocument={vi.fn()} initialExpanded={["", "week1"]} onExpandedChange={onExpandedChange} />,
    );
    // Scoped to the rail: "Syllabus" in the recent table also matches /lab/.
    const rail = () => within(screen.getByRole("navigation", { name: "Folders" }));
    await waitFor(() => rail().getByRole("button", { name: /^lab/ }));
    fireEvent.keyDown(rail().getByRole("button", { name: /week1/ }), { key: "ArrowLeft" });
    expect(onExpandedChange).toHaveBeenCalledWith([""]);
    expect(rail().queryByRole("button", { name: /^lab/ })).toBeNull();
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

    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
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

    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    const good = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [good] } });

    await waitFor(() => expect(screen.getByText(/boom|could not upload/i)).toBeTruthy());
  });

  // #42: folder upload and multi-select both hand handleFiles a FileList
  // with more than one entry. Each file uploads sequentially and, when the
  // browser populated webkitRelativePath (the folder-picker case), that path
  // rides along as the `relativePath` form field so the server can preserve
  // the folder structure.
  it("uploads multiple files sequentially, carrying relativePath when the browser set one", async () => {
    const postBodies: FormData[] = [];
    // The first POST is held open so the progress line has a moment to be
    // observed mid-run -- a folder upload is one request per file, and the
    // whole point of the indicator is that it is visible while that is
    // happening, not after.
    let releaseFirstPost = () => {};
    const firstPostHeld = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/materials")) {
          postBodies.push(init.body as FormData);
          if (postBodies.length === 1) await firstPostHeld;
          return new Response(JSON.stringify({ id: `m${postBodies.length}`, status: "pending" }), {
            status: 200,
          });
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

    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });
    Object.defineProperty(fileB, "webkitRelativePath", { value: "Module 1/b.txt" });

    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileA, fileB] } });

    // Visible DURING the run, naming the file in flight...
    await waitFor(() => expect(screen.getByText(/Uploading 1 of 2/)).toBeTruthy());
    releaseFirstPost();

    await waitFor(() => expect(postBodies.length).toBe(2));
    expect(postBodies[0].get("relativePath")).toBeNull();
    expect(postBodies[1].get("relativePath")).toBe("Module 1/b.txt");
    // ...and gone once the batch is finished.
    await waitFor(() => expect(screen.queryByText(/Uploading \d+ of/)).toBeNull());
  });

  it("reports which file failed when one of several uploads fails", async () => {
    let postCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/materials")) {
          postCount += 1;
          if (postCount === 2) {
            return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
          }
          return new Response(JSON.stringify({ id: "m1", status: "pending" }), { status: 200 });
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

    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });

    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileA, fileB] } });

    await waitFor(() => expect(screen.getByText(/1 of 2 files failed/i)).toBeTruthy());
    expect(screen.getByText(/b\.txt/)).toBeTruthy();
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
    await waitFor(() => screen.getByText(/All uploads/));
    // A ready upload is nothing to act on, so it sits only in the closed
    // disclosure at the bottom -- opened here to prove it did arrive.
    fireEvent.click(screen.getByText(/All uploads/));
    await waitFor(() => screen.getByText("lecture1.vtt"));
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
  });

  it("accepts a file within the allowed extensions and size without a client-side error", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
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

  it("does not poll a scan awaiting manual transcription", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ materials: { materials: [MATERIALS[1]] } });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1_000);
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
      materials: { materials: [{ ...MATERIALS[1], errorDetail: null }] }, // queued
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

  it("offers the whole knowledge base as a zip from the header", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    const link = screen.getByRole("link", { name: /Download all/ }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/courses/c1/knowledge/export");
  });

  it("offers a download on each row of a folder listing", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    fireEvent.click(screen.getByRole("button", { name: /week1/ }));
    await waitFor(() => screen.getByText("Lecture 1"));
    expect(screen.getByRole("link", { name: "Download Markdown for Lecture 1" }).getAttribute("href")).toBe(
      "/api/courses/c1/knowledge/documents/week1%2Flecture/download",
    );
    // Lecture 1 came from upload m1; the original is one click away too.
    expect(screen.getByRole("link", { name: "Download original upload for Lecture 1" }).getAttribute("href")).toBe(
      "/api/courses/c1/materials/m1/download",
    );
  });
});
