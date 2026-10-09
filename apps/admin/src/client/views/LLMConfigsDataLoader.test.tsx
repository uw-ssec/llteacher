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
  scopeCourseId: null as string | null,
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

/** #367: an Org Admin's list by default -- before #367 every instructor held
 *  that authority, so the pre-#367 tests below keep asserting what they did. */
const listResponse = (configs: unknown[], canManageOrgPool = true) =>
  new Response(JSON.stringify({ configs, canManageOrgPool }), {
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

  it("keeps an LLMoxie config on LLMoxie when it is edited, and creates new ones on OpenRouter", async () => {
    const LLMOXIE = { ...DEFAULT_CONFIG, provider: "llmoxie" as const };
    const fetchMock = stub((_url, init) => {
      if (init?.method === "PATCH" || init?.method === "POST") {
        return new Response(JSON.stringify({ config: LLMOXIE }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return listResponse([LLMOXIE]);
    });
    const sentProvider = (method: string) => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === method);
      return JSON.parse(String(call![1]!.body)).provider;
    };

    renderLoader({ kind: "edit", configId: "cfg-1" });
    await waitFor(() => screen.getByDisplayValue("Socratic default"));
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(sentProvider("PATCH")).toBe("llmoxie");
    cleanup();

    renderLoader({ kind: "create" });
    const name = await screen.findByLabelText(/^Name/i);
    fireEvent.change(name, { target: { value: "New config" } });
    fireEvent.click(screen.getByRole("button", { name: /Create|Save/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(sentProvider("POST")).toBe("openrouter");
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

/* #367: a course instructor who is not an Org Admin sees the shared pool as
   reference -- View and Copy, never an edit or Deactivate the server would
   refuse -- and their own course's configurations as fully editable. */
describe("shared vs course-owned configurations (#367)", () => {
  const OWN = { ...SPARE, id: "cfg-3", recordNumber: 3, name: "Our course tutor", scopeCourseId: "c1" };

  it("offers View and Copy-to-this-course on shared rows, and full actions on the course's own", async () => {
    stub(() => listResponse([DEFAULT_CONFIG, SPARE, OWN], false));
    renderLoader();
    await waitFor(() => screen.getByRole("button", { name: /Copy Free tier to this course/i }));
    expect(screen.queryByRole("button", { name: /Deactivate Free tier/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Deactivate Our course tutor/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
    expect(screen.getAllByText("shared")).toHaveLength(2);
    expect(screen.getByText("this course")).toBeTruthy();
  });

  it("opens a shared configuration read-only: inert controls, no save, no default, testing still allowed", async () => {
    stub(() => listResponse([DEFAULT_CONFIG, SPARE], false));
    renderLoader({ kind: "edit", configId: "cfg-2" });
    await waitFor(() => screen.getByRole("heading", { name: "Shared configuration" }));
    expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Save changes/ })).toBeNull();
    expect(screen.queryByText("Organization default")).toBeNull();
    // The test panel lives outside the lock.
    const testButtons = screen.getAllByRole("button").filter((b) => /test/i.test(b.textContent ?? ""));
    expect(testButtons.length).toBeGreaterThan(0);
  });

  it("lets an Org Admin edit a shared configuration and move the organization default", async () => {
    stub(() => listResponse([DEFAULT_CONFIG, SPARE], true));
    renderLoader({ kind: "edit", configId: "cfg-2" });
    await waitFor(() => screen.getByRole("heading", { name: "Edit configuration" }));
    expect(screen.getByLabelText("Name").matches(":disabled")).toBe(false);
    expect(screen.getByText("Organization default")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeTruthy();
  });

  it("does not offer the organization default on a course's own configuration", async () => {
    stub(() => listResponse([DEFAULT_CONFIG, { ...SPARE, scopeCourseId: "c1" }], true));
    renderLoader({ kind: "edit", configId: "cfg-2" });
    await waitFor(() => screen.getByRole("heading", { name: "Edit configuration" }));
    expect(screen.queryByText("Organization default")).toBeNull();
  });
});

