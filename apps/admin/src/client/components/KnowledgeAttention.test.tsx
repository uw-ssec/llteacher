// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { KnowledgeAttention } from "./KnowledgeAttention";
import type { MaterialPayload } from "@llteacher/ui/api";

afterEach(cleanup);

const mat = (over: Partial<MaterialPayload>): MaterialPayload => ({
  id: "m", title: "m", sourceType: "pdf", originalFilename: "m.pdf", relativePath: null, byteSize: 1,
  contentType: "application/pdf", status: "ready", errorDetail: null, uploadedAt: "2026-09-01T00:00:00.000Z", ...over,
});

function renderList(materials: MaterialPayload[], over: Partial<React.ComponentProps<typeof KnowledgeAttention>> = {}) {
  const props = { materials, filter: null, showAll: false, onShowAll: vi.fn(), onRetry: vi.fn(), onRetryAllFailed: vi.fn(), ...over };
  render(<KnowledgeAttention {...props} />);
  return props;
}

describe("KnowledgeAttention", () => {
  it("lists only uploads that are not ready, with their reason", () => {
    renderList([
      mat({ id: "ok", originalFilename: "fine.vtt", status: "ready" }),
      mat({ id: "p", originalFilename: "scan.pdf", status: "pending", errorDetail: "No text layer." }),
      mat({ id: "f", relativePath: "week1/bad.docx", status: "failed", errorDetail: "Password protected." }),
    ]);
    expect(screen.queryByText("fine.vtt")).toBeNull();
    expect(screen.getByText("scan.pdf")).toBeTruthy();
    expect(screen.getByText("No text layer.")).toBeTruthy();
    expect(screen.getByText("week1/bad.docx")).toBeTruthy();
    expect(screen.getByText("Password protected.")).toBeTruthy();
  });

  it("says when nothing needs a human", () => {
    renderList([mat({ status: "ready" })]);
    expect(screen.getByText(/Every upload has been converted/)).toBeTruthy();
  });

  it("shows five rows and offers the rest behind Show all", () => {
    const rows = Array.from({ length: 7 }, (_, i) => mat({ id: `m${i}`, originalFilename: `f${i}.pdf`, status: "pending" }));
    const { onShowAll } = renderList(rows);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
    expect(onShowAll).toHaveBeenCalled();
    cleanup();
    renderList(rows, { showAll: true });
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("retries one upload by name and all failed ones together", () => {
    const { onRetry, onRetryAllFailed } = renderList([
      mat({ id: "p", originalFilename: "scan.pdf", status: "pending" }),
      mat({ id: "f1", originalFilename: "one.docx", status: "failed" }),
      mat({ id: "f2", originalFilename: "two.docx", status: "failed" }),
    ]);
    fireEvent.click(screen.getByLabelText("Retry ingestion for scan.pdf"));
    expect(onRetry).toHaveBeenCalledWith("p");
    fireEvent.click(screen.getByRole("button", { name: "Retry all failed" }));
    expect(onRetryAllFailed).toHaveBeenCalled();
  });

  it("narrows to one status when a filter is set", () => {
    renderList(
      [mat({ id: "p", originalFilename: "scan.pdf", status: "pending" }), mat({ id: "f", originalFilename: "bad.docx", status: "failed" })],
      { filter: "failed" },
    );
    expect(screen.queryByText("scan.pdf")).toBeNull();
    expect(screen.getByText("bad.docx")).toBeTruthy();
  });

  it("names a queued upload as waiting rather than showing nothing", () => {
    renderList([mat({ id: "p", originalFilename: "scan.pdf", status: "processing", errorDetail: null })]);
    expect(screen.getByText(/Converting/)).toBeTruthy();
  });
});
