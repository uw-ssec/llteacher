// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ProfileView } from "./ProfileView";

afterEach(cleanup);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            userId: "u1",
            email: "cdcore@uw.edu",
            displayName: "Cordero",
            role: "instructor",
            courseCount: 2,
            instructorStats: { homeworksCreated: 3 },
          }),
          { status: 200 },
        ),
    ),
  );
});

describe("ProfileView", () => {
  it("renders decrypted profile fields and instructor stats", async () => {
    render(<ProfileView />);
    await waitFor(() => screen.getByText("cdcore@uw.edu"));
    expect(screen.getByText("Role: instructor")).toBeTruthy();
    expect(screen.getByText(/Homeworks created: 3/)).toBeTruthy();
  });

  it("shows a fallback message when the profile fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    render(<ProfileView />);
    await waitFor(() => screen.getByText(/unable to load/i));
  });
});
