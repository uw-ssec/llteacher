// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { KnowledgeSearchBox } from "./KnowledgeSearchBox";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("KnowledgeSearchBox", () => {
  it("searches on submit and opens a result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hits: [{ conceptId: "lectures/intro", title: "Intro", type: "lecture", description: "Markets", score: 2 }] }), { status: 200 })));
    const onOpen = vi.fn();
    render(<KnowledgeSearchBox courseId="c1" onOpenDocument={onOpen} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "markets" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(screen.getByText("Intro")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Intro/ }));
    expect(onOpen).toHaveBeenCalledWith("lectures/intro");
  });
  it("says when nothing matched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 })));
    render(<KnowledgeSearchBox courseId="c1" onOpenDocument={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(screen.getByText(/No documents matched/)).toBeTruthy());
  });
});
