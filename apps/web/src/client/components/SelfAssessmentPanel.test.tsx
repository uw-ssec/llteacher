// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelfAssessmentPanel } from "./SelfAssessmentPanel";

const WIDGETS = [
  { id: "w1", prePrompt: "Confident with means?", postPrompt: "Confident now?", order: 1, preValue: null, postValue: null },
  { id: "w2", prePrompt: "Confident with medians?", postPrompt: "And medians now?", order: 2, preValue: null, postValue: null },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SelfAssessmentPanel (#165)", () => {
  it("shows the phase's prompt for every widget, each as a labelled 0-10 slider", () => {
    render(<SelfAssessmentPanel phase="post" widgets={WIDGETS} onSubmitted={vi.fn()} onSkip={vi.fn()} />);
    for (const prompt of ["Confident now?", "And medians now?"]) {
      const slider = screen.getByLabelText(prompt) as HTMLInputElement;
      expect(slider.type).toBe("range");
      expect([slider.min, slider.max]).toEqual(["0", "10"]);
    }
    expect(screen.queryByLabelText("Confident with means?")).toBeNull();
  });

  it("saves one response per widget with the chosen values, then reports them", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { which: string; value: number };
        bodies.push({ url, method: init?.method, ...body });
        return new Response(JSON.stringify({ widgetId: url.split("/")[3], preValue: body.value, postValue: null }), { status: 200 });
      }),
    );
    const onSubmitted = vi.fn();
    render(<SelfAssessmentPanel phase="pre" widgets={WIDGETS} onSubmitted={onSubmitted} onSkip={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Confident with means?"), { target: { value: "2" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    expect(bodies).toEqual([
      { url: "/api/widgets/w1/response", method: "PATCH", which: "pre", value: 2 },
      // Untouched slider: its visible starting value, the scale midpoint.
      { url: "/api/widgets/w2/response", method: "PATCH", which: "pre", value: 5 },
    ]);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted.mock.calls[0]![0]).toHaveLength(2);
  });

  it("keeps the panel and offers retry or skip when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onSubmitted = vi.fn();
    const onSkip = vi.fn();
    render(<SelfAssessmentPanel phase="pre" widgets={WIDGETS} onSubmitted={onSubmitted} onSkip={onSkip} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't be saved/);
    expect(onSubmitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
