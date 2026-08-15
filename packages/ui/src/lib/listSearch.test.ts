import { describe, it, expect } from "vitest";
import { fold, searchRows } from "./listSearch";

type Row = { name: string; note?: string };
const rows = (...names: string[]): Row[] => names.map((name) => ({ name }));
const names = (result: Row[]) => result.map((r) => r.name);
const search = (data: Row[], q: string) =>
  names(searchRows(data, q, { fields: (r) => [r.name, r.note] }));

describe("fold", () => {
  it("folds case and diacritics so an unaccented query reaches an accented name", () => {
    expect(fold("José")).toBe("jose");
    expect(fold("Müller")).toBe("muller");
    expect(fold("Renée")).toBe("renee");
  });

  // NFD cannot decompose these -- they are distinct letters, not letter +
  // combining mark -- so they need the explicit table.
  it("folds letters that carry no separable diacritic", () => {
    expect(fold("Straße")).toBe("strasse");
    expect(fold("Søren")).toBe("soren");
    expect(fold("Łukasz")).toBe("lukasz");
    expect(fold("Æsop")).toBe("aesop");
  });
});

describe("searchRows — substring pass", () => {
  it("returns everything untouched for an empty query", () => {
    const data = rows("Zoe", "Adam");
    expect(search(data, "")).toEqual(["Zoe", "Adam"]);
    expect(search(data, "   ")).toEqual(["Zoe", "Adam"]);
  });

  it("ranks whole-field prefixes above word starts above mid-word hits", () => {
    const data = rows("Alexander, Sam", "Chen, Andrea", "Anderson, Maya");
    // "Anderson" starts the field; "Andrea" starts a word; "Alexander"
    // only contains "and" mid-word.
    expect(search(data, "and")).toEqual(["Anderson, Maya", "Chen, Andrea", "Alexander, Sam"]);
  });

  it("treats a hyphen or apostrophe as a word boundary", () => {
    const data = rows("Smith-Baker, Jo", "Macbeth, Al");
    expect(search(data, "baker")).toEqual(["Smith-Baker, Jo"]);
  });

  it("finds an accented name from an unaccented query", () => {
    const data = rows("José Ramírez", "Jonas Weber");
    expect(search(data, "jose")).toEqual(["José Ramírez"]);
  });

  it("matches across any of the configured fields", () => {
    const data: Row[] = [{ name: "Config A", note: "gpt-4o-mini" }, { name: "Config B", note: "sonnet" }];
    expect(search(data, "sonnet")).toEqual(["Config B"]);
  });

  it("holds input order within a rank bucket so the caller's sort survives", () => {
    const data = rows("Anna B", "Anna A");
    expect(search(data, "anna")).toEqual(["Anna B", "Anna A"]);
  });
});

describe("searchRows — fuzzy fallback", () => {
  // The central design claim: fuzzy must not dilute a real hit.
  it("does not run when the substring pass found anything", () => {
    const data = rows("Anderson, Maya", "Nathan Wu", "Joanna Diaz", "Alexandra Kim");
    // All four are subsequence matches for "and"; only the true substring
    // matches may come back.
    expect(search(data, "and")).toEqual(["Anderson, Maya", "Alexandra Kim"]);
    expect(search(data, "and")).not.toContain("Nathan Wu");
    expect(search(data, "and")).not.toContain("Joanna Diaz");
  });

  it("rescues an omitted character", () => {
    expect(search(rows("Anderson, Maya", "Chen, Bo"), "andersn")).toEqual(["Anderson, Maya"]);
  });

  // The reason this is Damerau rather than plain Levenshtein. The query has
  // to be SHORT for this to discriminate: plain Levenshtein scores a
  // transposition as 2 (two substitutions), which a 6+ char query's budget of
  // 2 already covers -- so a long transposed query passes either way and
  // proves nothing. At 4 characters the budget is 1, and only Damerau's
  // adjacent-swap rule brings "cehn" within it. (Verified by mutation: the
  // 8-char version of this test passed with the transposition branch
  // disabled.)
  it("rescues a transposition inside the one-edit budget", () => {
    expect(search(rows("Chen, Bo", "Anderson, Maya"), "cehn")).toEqual(["Chen, Bo"]);
  });

  it("rescues a transposition in a longer query too", () => {
    expect(search(rows("Anderson, Maya", "Chen, Bo"), "andesron")).toEqual(["Anderson, Maya"]);
  });

  it("rescues a doubled character and a wrong letter", () => {
    expect(search(rows("Anderson, Maya"), "anderrson")).toEqual(["Anderson, Maya"]);
    expect(search(rows("Anderson, Maya"), "andersan")).toEqual(["Anderson, Maya"]);
  });

  it("rescues a typo in a later word, not just the first", () => {
    expect(search(rows("Maya Anderson", "Bo Chen"), "andersn")).toEqual(["Maya Anderson"]);
  });

  it("stays silent on a query too short to guess from", () => {
    // Must be a query the fuzzy pass WOULD otherwise rescue, or the floor is
    // not what produced the empty result. "mz" is one edit from "ma", the
    // leading slice of "Maya" -- inside the budget, blocked only by the
    // minimum length. (Verified by mutation: an arbitrary two-letter miss
    // like "xy" passed with the floor removed, because it matched nothing
    // either way.)
    expect(search(rows("Maya Anderson"), "mz")).toEqual([]);
    // One character longer, the same near-miss is allowed through.
    expect(search(rows("Maya Anderson"), "mzya")).toEqual(["Maya Anderson"]);
  });

  it("returns nothing when the query is not a plausible typo of anything", () => {
    expect(search(rows("Anderson, Maya", "Chen, Bo"), "qwerty")).toEqual([]);
  });

  it("keeps a short query from reaching an unrelated word on its edit budget", () => {
    // "may" is one edit from "man"/"max"/"way"; the budget must not let a
    // 3-char query sweep in unrelated rows once the substring pass fails.
    expect(search(rows("Winter, Max"), "joy")).toEqual([]);
  });
});
