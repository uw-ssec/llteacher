/* --------------------------------------------------------------------------
   #210: the accession panel.

   The behaviour under test is the one #210 is explicit about -- every entered
   NetID comes back with its own outcome, because one collective "failed"
   cannot tell an instructor which three of eight were typos.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { AddTasPanel, splitNetids, type AddTaResult } from "./AddTasPanel";

afterEach(cleanup);

function renderPanel(onAdd: (netids: string[]) => Promise<AddTaResult[]>, open = true) {
  const announce = vi.fn();
  render(
    <AddTasPanel onAdd={onAdd} defaultOpen={open} maxPerRequest={100} onAnnounce={announce} />,
  );
  return { announce };
}

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText(/UW NetIDs/i), { target: { value: text } });

describe("splitNetids (#210)", () => {
  it("splits on the separators a pasted list actually uses", () => {
    // Instructors paste from someone else's email; making them reformat it is
    // the kind of tax that ends with them messaging a developer instead.
    expect(splitNetids("ada, grace\nalan;  linus\tkatherine")).toEqual([
      "ada",
      "grace",
      "alan",
      "linus",
      "katherine",
    ]);
  });

  it("drops empty entries from trailing separators", () => {
    expect(splitNetids("ada,\n\n")).toEqual(["ada"]);
  });
});

describe("AddTasPanel (#210)", () => {
  it("shows an outcome for every entered NetID, not one collective result", async () => {
    renderPanel(async () => [
      { netid: "ada", status: "added", membershipId: "m-1" },
      { netid: "grace", status: "already_ta", membershipId: "m-2" },
      { netid: "not a netid", status: "invalid_netid" },
      { netid: "bob", status: "role_conflict", existingRole: "student" },
    ]);
    type("ada grace bob");
    fireEvent.click(screen.getByRole("button", { name: /Add \d+ TAs?/i }));

    await waitFor(() => screen.getByText("Added"));
    for (const netid of ["ada", "grace", "not a netid", "bob"]) {
      expect(screen.getByText(netid)).toBeTruthy();
    }
    expect(screen.getByText("Already a TA")).toBeTruthy();
    expect(screen.getByText("Not a NetID")).toBeTruthy();
    // role_conflict names what they already are, so the instructor can decide
    // deliberately rather than being told only that it did not work.
    expect(screen.getByText(/Already on this course as student/i)).toBeTruthy();
  });

  it("keeps a rejected NetID in the box and clears the ones that landed", async () => {
    renderPanel(async () => [
      { netid: "ada", status: "added", membershipId: "m-1" },
      { netid: "notanetidatall", status: "invalid_netid" },
    ]);
    type("ada\nnotanetidatall");
    fireEvent.click(screen.getByRole("button", { name: /Add \d+ TAs?/i }));

    await waitFor(() => screen.getByText("Not a NetID"));
    // Correcting a typo should be an edit, not a retype of the whole list.
    expect((screen.getByLabelText(/UW NetIDs/i) as HTMLTextAreaElement).value).toBe(
      "notanetidatall",
    );
  });

  it("states the batch cap before enforcing it, and blocks submit", () => {
    const onAdd = vi.fn();
    render(<AddTasPanel onAdd={onAdd} defaultOpen maxPerRequest={2} onAnnounce={vi.fn()} />);
    type("a b c");
    // Discovering the bound as a 400 after pasting a long list is the worse
    // version of this.
    expect(screen.getByText(/add at most 2 at a time/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add \d+ TAs?/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("does nothing on an empty box", () => {
    const onAdd = vi.fn();
    renderPanel(onAdd as never);
    fireEvent.click(screen.getByRole("button", { name: /Add TAs?/i }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("reports a failed request without claiming anything was added", async () => {
    renderPanel(async () => {
      throw new Error("boom");
    });
    type("ada");
    fireEvent.click(screen.getByRole("button", { name: /Add 1 TA/i }));
    await waitFor(() => screen.getByText(/Could not add those TAs/i));
    expect(screen.queryByText("Added")).toBeNull();
  });

  it("announces the outcome summary rather than leaving it to the ledger alone", async () => {
    const { announce } = renderPanel(async () => [
      { netid: "ada", status: "added", membershipId: "m-1" },
      { netid: "zz zz", status: "invalid_netid" },
    ]);
    type("ada");
    fireEvent.click(screen.getByRole("button", { name: /Add 1 TA/i }));
    // The ledger is a list that appears below the form; a screen-reader user
    // needs to be told it is there and roughly what it says.
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith(expect.stringMatching(/1 added, 1 not added/)),
    );
  });

  it("opens from a closed affordance when the course already has TAs", () => {
    render(<AddTasPanel onAdd={vi.fn()} maxPerRequest={100} onAnnounce={vi.fn()} />);
    // Collapsed by default when the table below is the main content, so the
    // form does not push the grant table off screen on every visit.
    expect(screen.queryByLabelText(/UW NetIDs/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add teaching assistants/i }));
    expect(screen.getByLabelText(/UW NetIDs/i)).toBeTruthy();
  });
});
