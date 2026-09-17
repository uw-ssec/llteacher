// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { KnowledgeSearchResults } from "./KnowledgeSearchResults";
import type { KnowledgeDocumentSummaryPayload } from "@llteacher/ui/api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const doc = (id: string, path: string, title: string, over: Partial<KnowledgeDocumentSummaryPayload> = {}): KnowledgeDocumentSummaryPayload => ({
  id, path, kind: "concept", type: "lecture", title, description: null, tags: null,
  indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z", ...over,
});
const DOCS = [
  doc("d1", "week1/problem-sets/problem-set-1", "Problem Set 1", { updatedAt: "2026-09-03T00:00:00.000Z" }),
  doc("d2", "week1/problem-sets/problem-set-2", "Problem Set 2", { updatedAt: "2026-09-02T00:00:00.000Z" }),
  doc("d3", "week2/lecture-gdp", "GDP lecture"),
  doc("d4", "week1/index", "index", { kind: "index" }),
];
const HITS = [
  { conceptId: "week1/problem-sets/problem-set-2", title: "Problem Set 2", type: "lecture", description: "GDP per capita problems", score: 4.2 },
  { conceptId: "week2/lecture-gdp", title: "GDP lecture", type: "lecture", description: "Measuring GDP", score: 2.1 },
];

function stubSearch(hits = HITS, status = 200) {
  const mock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(status === 200 ? { hits } : { error: "boom" }), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderResults(over: Partial<React.ComponentProps<typeof KnowledgeSearchResults>> = {}) {
  const props = {
    courseId: "c1", query: "gdp", submittedQuery: null as string | null, scope: null as string | null,
    documents: DOCS, onOpenDocument: vi.fn(), onRevealFolder: vi.fn(), ...over,
  };
  const r = render(<KnowledgeSearchResults {...props} />);
  return { ...props, rerender: (next: Partial<typeof props>) => r.rerender(<KnowledgeSearchResults {...props} {...next} />) };
}

describe("KnowledgeSearchResults", () => {
  it("matches file names instantly, before any content search has run", () => {
    stubSearch();
    renderResults({ query: "problem" });
    fireEvent.click(screen.getByRole("button", { name: /File names/ }));
    // Titles are highlighted, so match by the row's accessible name.
    expect(screen.getByRole("button", { name: "Open Problem Set 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Problem Set 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open GDP lecture" })).toBeNull();
    expect(screen.getByRole("button", { name: /File names/ }).textContent).toMatch(/2/);
  });

  it("scopes name matches to the selected folder", () => {
    stubSearch();
    renderResults({ query: "e", scope: "week2" });
    fireEvent.click(screen.getByRole("button", { name: /File names/ }));
    expect(screen.getByRole("button", { name: "Open GDP lecture" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Problem Set 1" })).toBeNull();
  });

  it("asks for Enter before a content search has run", () => {
    stubSearch();
    renderResults({ query: "gdp", submittedQuery: null });
    expect(screen.getByText(/Press Enter to search inside/)).toBeTruthy();
  });

  it("fetches content hits for the submitted query with the folder scope and ranks them", async () => {
    const fetchMock = stubSearch();
    renderResults({ query: "gdp", submittedQuery: "gdp", scope: "week1" });
    await waitFor(() => screen.getByText("Problem Set 2"));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/knowledge/search?q=gdp&dir=week1");
    const rows = screen.getAllByRole("button", { name: /Open / });
    expect(rows[0].textContent).toMatch(/Problem Set 2/);
    expect(rows[1].textContent).toMatch(/GDP lecture/);
    expect(screen.getByRole("button", { name: /Inside documents/ }).textContent).toMatch(/2/);
  });

  it("highlights the query terms in the description", async () => {
    stubSearch();
    renderResults({ query: "gdp", submittedQuery: "gdp" });
    await waitFor(() => screen.getByText("Problem Set 2"));
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent?.toLowerCase()).toBe("gdp");
  });

  it("opens a hit and reveals a folder from a path segment", async () => {
    stubSearch();
    const { onOpenDocument, onRevealFolder } = renderResults({ query: "gdp", submittedQuery: "gdp" });
    await waitFor(() => screen.getByText("Problem Set 2"));
    fireEvent.click(screen.getByRole("button", { name: "Open Problem Set 2" }));
    expect(onOpenDocument).toHaveBeenCalledWith("week1/problem-sets/problem-set-2");
    fireEvent.click(screen.getByRole("button", { name: "Show folder week1/problem-sets" }));
    expect(onRevealFolder).toHaveBeenCalledWith("week1/problem-sets");
  });

  it("shows ten rows and the rest behind Show all", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ conceptId: `w/c${i}`, title: `Concept ${i}`, type: "lecture", description: "", score: 14 - i }));
    stubSearch(many);
    renderResults({ query: "concept", submittedQuery: "concept" });
    await waitFor(() => screen.getByRole("button", { name: "Open Concept 0" }));
    expect(screen.getAllByRole("button", { name: /Open Concept/ })).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show all 14" }));
    expect(screen.getAllByRole("button", { name: /Open Concept/ })).toHaveLength(14);
  });

  it("sorts by name or last updated instead of relevance", async () => {
    stubSearch();
    renderResults({ query: "gdp", submittedQuery: "gdp" });
    await waitFor(() => screen.getByText("Problem Set 2"));
    fireEvent.change(screen.getByLabelText("Sort results"), { target: { value: "name" } });
    let rows = screen.getAllByRole("button", { name: /Open / });
    expect(rows[0].textContent).toMatch(/GDP lecture/);
    fireEvent.change(screen.getByLabelText("Sort results"), { target: { value: "updated" } });
    rows = screen.getAllByRole("button", { name: /Open / });
    expect(rows[0].textContent).toMatch(/Problem Set 2/);
  });

  it("says when nothing inside the documents matched", async () => {
    stubSearch([]);
    renderResults({ query: "zzz", submittedQuery: "zzz" });
    await waitFor(() => screen.getByText(/Nothing inside the documents matched/));
  });

  it("reports a failed content search", async () => {
    stubSearch([], 500);
    renderResults({ query: "gdp", submittedQuery: "gdp" });
    await waitFor(() => screen.getByRole("alert"));
  });

  it("shows a status badge on a hit that is not indexed yet", async () => {
    stubSearch([HITS[1]]);
    renderResults({ query: "gdp", submittedQuery: "gdp", documents: [doc("d3", "week2/lecture-gdp", "GDP lecture", { indexStatus: "pending" })] });
    await waitFor(() => screen.getByRole("button", { name: "Open GDP lecture" }));
    const row = screen.getByRole("button", { name: "Open GDP lecture" }).closest("li")!;
    expect(within(row).getByText("Pending")).toBeTruthy();
  });

  it("offers a Markdown download on every hit and an original download only when one exists", async () => {
    stubSearch();
    renderResults({ query: "gdp", submittedQuery: "gdp", documents: [
      doc("d2", "week1/problem-sets/problem-set-2", "Problem Set 2", { sourceMaterialId: "m2" }),
      doc("d3", "week2/lecture-gdp", "GDP lecture", { sourceMaterialId: null }),
    ] });
    await waitFor(() => screen.getByRole("button", { name: "Open Problem Set 2" }));
    const md = screen.getByRole("link", { name: "Download Markdown for Problem Set 2" }) as HTMLAnchorElement;
    expect(md.getAttribute("href")).toBe("/api/courses/c1/knowledge/documents/week1%2Fproblem-sets%2Fproblem-set-2/download");
    expect(md.getAttribute("download")).toBe("problem-set-2.md");
    const original = screen.getByRole("link", { name: "Download original upload for Problem Set 2" }) as HTMLAnchorElement;
    expect(original.getAttribute("href")).toBe("/api/courses/c1/materials/m2/download");
    expect(screen.queryByRole("link", { name: "Download original upload for GDP lecture" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download Markdown for GDP lecture" })).toBeTruthy();
  });

  it("offers the same downloads on file-name matches", () => {
    stubSearch();
    renderResults({ query: "problem" });
    fireEvent.click(screen.getByRole("button", { name: /File names/ }));
    expect(screen.getByRole("link", { name: "Download Markdown for Problem Set 1" })).toBeTruthy();
  });
});
