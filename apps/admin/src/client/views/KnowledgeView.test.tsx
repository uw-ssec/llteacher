import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { KnowledgeView } from "./KnowledgeView";

afterEach(cleanup);

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
});
