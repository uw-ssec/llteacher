/* --------------------------------------------------------------------------
   #31 / #170 / #98 / #33: the config screens against the API.

   What is worth pinning here is the console's half of the invariants the
   server enforces: that the default has no Deactivate control at all rather
   than a disabled one, that a failed save keeps the form populated, and that
   the test button tests the SAVED configuration.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { LLMConfigsDataLoader, type ConfigScreen } from "./LLMConfigsDataLoader";

afterEach(cleanup);

const DEFAULT_CONFIG = {
  id: "cfg-1",
  recordNumber: 1,
  name: "Socratic default",
  provider: "openrouter" as const,
  modelName: "google/gemma-4-31b-it:free",
  basePrompt: "You are a tutor.",
  temperature: 0.7,
  maxCompletionTokens: 1000,
  fallbackLlmConfigId: null,
  isDefault: true,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const SPARE = {
  ...DEFAULT_CONFIG,
  id: "cfg-2",
  recordNumber: 2,
  name: "Free tier",
  isDefault: false,
};

function stub(handler: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const listResponse = (configs: unknown[]) =>
  new Response(JSON.stringify({ configs }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function renderLoader(screenState: ConfigScreen = { kind: "list" }) {
  const onScreenChange = vi.fn();
  render(
    <LLMConfigsDataLoader courseId="c1" screen={screenState} onScreenChange={onScreenChange} />,
  );
  return { onScreenChange };
}

describe("LLM config list (#31, #170)", () => {
  it("renders live configs with their catalog numbers", async () => {
    stub(() => listResponse([DEFAULT_CONFIG, SPARE]));
    renderLoader();
    await waitFor(() => screen.getByRole("button", { name: /Copy Socratic default/i }));
    expect(screen.getByRole("button", { name: /^Free tier$/ })).toBeTruthy();
  });

  it("offers no Deactivate on the default, rather than a disabled one", async () => {
    stub(() => listResponse([DEFAULT_CONFIG, SPARE]));
    renderLoader();
    await waitFor(() => screen.getByRole("button", { name: /Copy Socratic default/i }));
    // The server refuses it -- the default is what every unpinned homework
    // resolves to -- and a control that always fails is the dead end #172
    // exists to remove.
    expect(screen.queryByRole("button", { name: /Deactivate Socratic default/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Deactivate Free tier/i })).toBeTruthy();
  });

  it("clones into the copy so the instructor can start changing it", async () => {
    const fetchMock = stub((url, init) => {
      if (init?.method === "POST" && url.includes("/clone")) {
        return new Response(JSON.stringify({ ...SPARE, id: "cfg-3", name: "Experiment" }), {
          status: 201,
        });
      }
      return listResponse([DEFAULT_CONFIG]);
    });
    vi.stubGlobal("prompt", vi.fn(() => "Experiment"));
    const { onScreenChange } = renderLoader();
    await waitFor(() => screen.getByRole("button", { name: /Copy Socratic default/i }));

    fireEvent.click(screen.getByRole("button", { name: /Copy Socratic default/i }));
    await waitFor(() =>
      expect(onScreenChange).toHaveBeenCalledWith({ kind: "edit", configId: "cfg-3" }),
    );
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/clone"))).toBe(true);
  });

  it("does not clone when the name prompt is cancelled", async () => {
    const fetchMock = stub(() => listResponse([DEFAULT_CONFIG]));
    vi.stubGlobal("prompt", vi.fn(() => null));
    renderLoader();
    await waitFor(() => screen.getByRole("button", { name: /Copy Socratic default/i }));
    fireEvent.click(screen.getByRole("button", { name: /Copy Socratic default/i }));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/clone"))).toBe(false);
  });

  it("surfaces the server's own sentence when deactivation is refused", async () => {
    stub((_url, init) => {
      if (init?.method === "DELETE") {
        return new Response(
          JSON.stringify({
            error:
              "This is the default configuration for your organization. Make another configuration the default first, then deactivate this one.",
          }),
          { status: 409 },
        );
      }
      return listResponse([DEFAULT_CONFIG, SPARE]);
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderLoader();
    await waitFor(() => screen.getByRole("button", { name: /^Free tier$/ }));

    fireEvent.click(screen.getByRole("button", { name: /Deactivate Free tier/i }));
    // The server's sentence names the unblocking step; a generic failure
    // would leave the instructor with nothing to do.
    await waitFor(() => screen.getByText(/Make another configuration the default first/i));
  });
});

describe("LLM config form (#31, #98)", () => {
  it("offers the org's other ACTIVE configs as fallbacks, never itself", async () => {
    stub(() =>
      listResponse([DEFAULT_CONFIG, SPARE, { ...SPARE, id: "cfg-3", name: "Retired", isActive: false }]),
    );
    renderLoader({ kind: "edit", configId: "cfg-1" });
    await waitFor(() => screen.getByLabelText(/Fall back to/i));

    const options = Array.from(
      (screen.getByLabelText(/Fall back to/i) as HTMLSelectElement).options,
    ).map((o) => o.textContent ?? "");
    // A config cannot be its own fallback (the database refuses it), and a
    // retired config is one an instructor deliberately stopped using.
    expect(options.some((o) => o.includes("Socratic default"))).toBe(false);
    expect(options.some((o) => o.includes("Free tier"))).toBe(true);
    expect(options.some((o) => o.includes("Retired"))).toBe(false);
  });

  it("keeps the form populated when a save fails", async () => {
    stub((_url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
      }
      return listResponse([DEFAULT_CONFIG]);
    });
    renderLoader({ kind: "edit", configId: "cfg-1" });
    await waitFor(() => screen.getByDisplayValue("Socratic default"));

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => screen.getByText(/couldn't be saved/i));
    // #34's error-recovery requirement: the instructor corrects and
    // resubmits rather than retyping everything.
    expect(screen.getByDisplayValue("Socratic default")).toBeTruthy();
  });

  it("shows what the model said, and does not save when testing", async () => {
    const fetchMock = stub((url, init) => {
      if (init?.method === "POST" && url.includes("/test")) {
        return new Response(
          JSON.stringify({
            ok: true,
            text: "What do you already know about this?",
            modelName: DEFAULT_CONFIG.modelName,
            usage: { inputTokens: 40, outputTokens: 9 },
          }),
          { status: 200 },
        );
      }
      return listResponse([DEFAULT_CONFIG]);
    });
    renderLoader({ kind: "edit", configId: "cfg-1" });
    await waitFor(() => screen.getByRole("button", { name: /Send test message/i }));

    fireEvent.click(screen.getByRole("button", { name: /Send test message/i }));
    await waitFor(() => screen.getByText(/What do you already know/i));
    expect(screen.getByText(/40 in · 9 out/)).toBeTruthy();
    // type="button": inside the same form as Save, a default submit would
    // save the configuration every time an instructor meant to test it.
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it("reports a refusing model without claiming the console broke", async () => {
    stub((url, init) => {
      if (init?.method === "POST" && url.includes("/test")) {
        return new Response(
          JSON.stringify({
            ok: false,
            modelName: DEFAULT_CONFIG.modelName,
            error: "The model gateway rejected that request. Check the model id, then try again.",
          }),
          { status: 200 },
        );
      }
      return listResponse([DEFAULT_CONFIG]);
    });
    renderLoader({ kind: "edit", configId: "cfg-1" });
    await waitFor(() => screen.getByRole("button", { name: /Send test message/i }));
    fireEvent.click(screen.getByRole("button", { name: /Send test message/i }));
    await waitFor(() => screen.getByText(/did not reply/i));
    expect(screen.getByText(/Check the model id/i)).toBeTruthy();
  });

  it("offers no test button when creating, since there is nothing saved to test", async () => {
    stub(() => listResponse([DEFAULT_CONFIG]));
    renderLoader({ kind: "create" });
    await waitFor(() => screen.getByText(/New configuration/i));
    // Testing unsaved form values would answer a different question than
    // "will this work for my students".
    expect(screen.queryByRole("button", { name: /Send test message/i })).toBeNull();
  });

  it("states the case plainly when the config is gone", async () => {
    stub(() => listResponse([DEFAULT_CONFIG]));
    renderLoader({ kind: "edit", configId: "cfg-missing" });
    // A dead form is worse than a stated fact.
    await waitFor(() => screen.getByText(/no longer exists/i));
  });
});
