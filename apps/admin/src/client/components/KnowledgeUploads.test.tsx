// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { KnowledgeUploads } from "./KnowledgeUploads";
import type { MaterialPayload } from "@llteacher/ui/api";

afterEach(cleanup);

const mat = (over: Partial<MaterialPayload>): MaterialPayload => ({
  id: "m", title: "m", sourceType: "pdf", originalFilename: "m.pdf", relativePath: null, byteSize: 2048,
  contentType: "application/pdf", status: "ready", errorDetail: null, uploadedAt: "2026-09-01T00:00:00.000Z", ...over,
});

describe("KnowledgeUploads", () => {
  it("is closed by default, names its size in the summary, and renders rows only once opened", () => {
    render(<KnowledgeUploads courseId="c1" materials={[mat({ id: "a", originalFilename: "a.pdf" }), mat({ id: "b" })]} />);
    const details = screen.getByText(/All uploads/).closest("details")!;
    expect(details.open).toBe(false);
    expect(screen.getByText(/All uploads/).textContent).toMatch(/2/);
    expect(screen.queryByText("a.pdf")).toBeNull();
    fireEvent.click(screen.getByText(/All uploads/));
    expect(details.open).toBe(true);
    expect(screen.getByText("a.pdf")).toBeTruthy();
  });

  it("filters by file name", () => {
    render(<KnowledgeUploads courseId="c1" materials={[mat({ id: "a", originalFilename: "alpha.pdf" }), mat({ id: "b", relativePath: "week1/beta.vtt" })]} />);
    fireEvent.click(screen.getByText(/All uploads/));
    fireEvent.change(screen.getByLabelText("Filter uploads by file name"), { target: { value: "beta" } });
    expect(screen.queryByText("alpha.pdf")).toBeNull();
    expect(screen.getByText("week1/beta.vtt")).toBeTruthy();
  });

  it("pages 25 at a time, newest first", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      mat({ id: `m${i}`, originalFilename: `f${i}.pdf`, uploadedAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z` }),
    );
    render(<KnowledgeUploads courseId="c1" materials={rows} />);
    fireEvent.click(screen.getByText(/All uploads/));
    expect(screen.getAllByRole("row")).toHaveLength(26); // header + 25
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    // f27 (Sep 28) sorts before f0 (Sep 1).
    const firstRow = screen.getAllByRole("row")[1]!;
    expect(firstRow.textContent).toMatch(/f27\.pdf/);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getAllByRole("row")).toHaveLength(6);
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  });

  it("says when nothing has been uploaded", () => {
    render(<KnowledgeUploads courseId="c1" materials={[]} />);
    fireEvent.click(screen.getByText(/All uploads/));
    expect(screen.getByText(/Nothing uploaded yet/)).toBeTruthy();
  });

  it("links each upload to its original file", () => {
    render(<KnowledgeUploads courseId="c1" materials={[mat({ id: "m9", originalFilename: "notes.pdf" })]} />);
    fireEvent.click(screen.getByText(/All uploads/));
    const link = screen.getByRole("link", { name: "Download notes.pdf" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/courses/c1/materials/m9/download");
  });
});
