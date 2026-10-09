import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROSTER_CSV_TEMPLATE,
  ROSTER_CSV_TEMPLATE_FILENAME,
  downloadRosterCsvTemplate,
} from "./rosterCsvTemplate";

afterEach(() => vi.restoreAllMocks());

describe("roster CSV template", () => {
  it("downloads the canonical email, name, and role template", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:roster-template");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const createElement = vi.spyOn(document, "createElement");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadRosterCsvTemplate();

    expect(ROSTER_CSV_TEMPLATE).toBe(
      "email,name,role\r\nalovelace@uw.edu,Ada Lovelace,student\r\nghopper@uw.edu,Grace Hopper,ta\r\n",
    );
    expect(ROSTER_CSV_TEMPLATE_FILENAME).toBe("llteacher-roster-template.csv");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/csv");
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.readAsText(blob);
    });
    expect(contents).toBe(ROSTER_CSV_TEMPLATE);
    const anchor = createElement.mock.results[0]!.value as HTMLAnchorElement;
    expect(anchor.download).toBe(ROSTER_CSV_TEMPLATE_FILENAME);
    expect(anchor.href).toBe("blob:roster-template");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:roster-template");
  });
});
