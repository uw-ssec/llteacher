// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { KnowledgeStatusStrip } from "./KnowledgeStatusStrip";
import type { KnowledgeDocumentSummaryPayload, MaterialPayload } from "@llteacher/ui/api";

afterEach(cleanup);

const doc = (over: Partial<KnowledgeDocumentSummaryPayload>): KnowledgeDocumentSummaryPayload => ({
  id: "d", path: "a", kind: "concept", type: "lecture", title: "A", description: null, tags: null,
  indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z", ...over,
});
const mat = (over: Partial<MaterialPayload>): MaterialPayload => ({
  id: "m", title: "m", sourceType: "pdf", originalFilename: "m.pdf", relativePath: null, byteSize: 1,
  contentType: "application/pdf", status: "ready", errorDetail: null, uploadedAt: "2026-09-01T00:00:00.000Z", ...over,
});

const DOCS = [
  doc({ id: "1", indexStatus: "indexed" }),
  doc({ id: "2", indexStatus: "pending" }),
  doc({ id: "3", kind: "index", indexStatus: "indexed" }),
];
const MATERIALS = [
  mat({ id: "a", status: "ready" }),
  mat({ id: "b", status: "pending" }),
  mat({ id: "c", status: "processing" }),
  mat({ id: "d", status: "failed" }),
];

describe("KnowledgeStatusStrip", () => {
  it("counts concepts, indexed concepts, in-flight and failed uploads, and uploads", () => {
    render(<KnowledgeStatusStrip documents={DOCS} materials={MATERIALS} filter={null} onFilter={vi.fn()} />);
    expect(screen.getByText("documents").previousSibling?.textContent).toBe("2");
    expect(screen.getByText("indexed").previousSibling?.textContent).toBe("1");
    expect(screen.getByRole("button", { name: /pending/ }).textContent).toMatch(/2/);
    expect(screen.getByRole("button", { name: /failed/ }).textContent).toMatch(/1/);
    expect(screen.getByText("uploads").previousSibling?.textContent).toBe("4");
  });

  it("filters to pending uploads and back", () => {
    const onFilter = vi.fn();
    const { rerender } = render(
      <KnowledgeStatusStrip documents={DOCS} materials={MATERIALS} filter={null} onFilter={onFilter} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /pending/ }));
    expect(onFilter).toHaveBeenCalledWith("pending");

    rerender(<KnowledgeStatusStrip documents={DOCS} materials={MATERIALS} filter="pending" onFilter={onFilter} />);
    expect(screen.getByRole("button", { name: /pending/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /pending/ }));
    expect(onFilter).toHaveBeenLastCalledWith(null);
  });
});
