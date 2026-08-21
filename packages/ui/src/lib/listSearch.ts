/* --------------------------------------------------------------------------
   listSearch — matching for the console's list controls.

   Two passes, in this order:

     1. Normalized substring, ranked so word-start matches beat mid-word ones.
        This is the pass that answers essentially every real query.
     2. Bounded edit distance, run ONLY when pass 1 found nothing at all.

   The ordering is the whole design. Running a fuzzy pass unconditionally is
   what makes fuzzy search feel unpredictable: query "and" over a student
   roster subsequence-matches Nathan, Joanna, and Alexandra alongside
   Anderson, and the instructor looking for one specific student now has to
   read a ranked list to find the obvious answer. Keeping fuzzy as a fallback
   means an exact hit is never diluted by a scored guess, while a typo still
   gets rescued.

   Why edit distance rather than fzf-style subsequence matching for the
   fallback: subsequence matching only rescues OMITTED characters. On names,
   the common slips are transposition ("Aderson" -> "Andesron"), doubling,
   and wrong vowels -- none of which are subsequences of the target.
   Damerau-Levenshtein covers all four classes, which is what a fallback that
   exists solely for typos actually needs.
   -------------------------------------------------------------------------- */

/* Characters that carry no diacritic to strip because they are distinct
   letters in their own alphabets, so NFD leaves them untouched. A roster at a
   public university has these in it. Not exhaustive -- it is the Latin-script
   set that shows up in practice, and anything missing degrades to "does not
   fold", never to a wrong match. */
const LETTER_FOLDS: Record<string, string> = {
  ß: "ss", ẞ: "ss",
  ø: "o", Ø: "o",
  đ: "d", Đ: "d", ð: "d", Ð: "d",
  ł: "l", Ł: "l",
  æ: "ae", Æ: "ae",
  œ: "oe", Œ: "oe",
  þ: "th", Þ: "th",
  ı: "i", İ: "i",
};

const FOLDABLE = new RegExp(`[${Object.keys(LETTER_FOLDS).join("")}]`, "g");

/** Case-folds and strips diacritics so `jose` finds `José` and `muller`
 *  finds `Müller`. NFD splits a letter from its combining marks, which are
 *  then dropped; the explicit table above covers the letters NFD cannot
 *  decompose. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(FOLDABLE, (c) => LETTER_FOLDS[c] ?? c)
    .toLowerCase();
}

/* Rank buckets. Lower sorts first. Kept as an enum-ish union rather than bare
   numbers so a caller reading the sort comparator can tell what it means. */
const RANK_PREFIX = 0; // query starts the whole field
const RANK_WORD = 1; // query starts some word within it
const RANK_MID = 2; // query appears, but mid-word
const RANK_FUZZY = 3; // no substring hit; rescued by edit distance

/** Where a folded query hits a folded haystack, as a rank bucket, or null for
 *  no hit at all. */
function substringRank(haystack: string, query: string): number | null {
  const at = haystack.indexOf(query);
  if (at < 0) return null;
  if (at === 0) return RANK_PREFIX;
  // A word start is any position preceded by something that isn't a letter or
  // digit -- space, hyphen, apostrophe, punctuation. This is what makes
  // "and" rank Chen, Andrea above Alexander, Sam.
  return /[^\p{L}\p{N}]/u.test(haystack[at - 1]!) ? RANK_WORD : RANK_MID;
}

/* Damerau-Levenshtein, abandoned as soon as every value in a row exceeds the
   budget. The early exit matters: this runs across every row of a roster on
   each keystroke, and without it a long field costs a full O(n*m) table for a
   result that was already disqualified. */
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      // The transposition case -- the reason this is Damerau and not plain
      // Levenshtein, and the reason "Andesron" still finds "Anderson".
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]! <= max;
}

/** Typo budget. One edit is plenty for a short query and keeps "may" from
 *  reaching unrelated three-letter words; longer queries earn a second. */
function editBudget(queryLength: number): number {
  return queryLength >= 6 ? 2 : 1;
}

/** Below this, a fuzzy pass matches so much that it is noise rather than
 *  rescue -- one edit on a two-character query reaches most of the alphabet. */
const MIN_FUZZY_QUERY = 3;

/** Does any single word of the field survive the typo budget? Compared per
 *  word rather than against the whole field so "andersn" can rescue
 *  "Anderson, Maya" without the surname's length blowing the budget. */
function fuzzyHit(haystack: string, query: string): boolean {
  const budget = editBudget(query.length);
  for (const word of haystack.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    // Compare against the word's leading slice as well as the whole word, so
    // a partial query ("ander") can still rescue a longer name.
    if (withinEditDistance(query, word, budget)) return true;
    if (word.length > query.length && withinEditDistance(query, word.slice(0, query.length), budget)) {
      return true;
    }
  }
  return false;
}

export interface SearchOptions<T> {
  /** Every field a row can be matched on. Joined for matching, so a query may
   *  hit any one of them. */
  fields: (row: T) => (string | null | undefined)[];
}

/**
 * Filters and ranks `rows` against `query`.
 *
 * An empty or whitespace-only query returns the input untouched and in its
 * original order -- searching for nothing is not a filter, and re-sorting on
 * an empty box would make the list jump the moment the field is focused.
 *
 * Ties hold their input order, so whatever sort the caller applied upstream
 * survives within a rank bucket.
 */
export function searchRows<T>(rows: T[], query: string, opts: SearchOptions<T>): T[] {
  const q = fold(query.trim());
  if (!q) return rows;

  const haystacks = rows.map((row) =>
    fold(opts.fields(row).filter(Boolean).join(" ")),
  );

  const hits: { row: T; rank: number; order: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rank = substringRank(haystacks[i]!, q);
    if (rank !== null) hits.push({ row: rows[i]!, rank, order: i });
  }

  // Only when the substring pass came back completely empty. A single exact
  // hit is a better answer than that hit plus a handful of near-misses.
  if (hits.length === 0 && q.length >= MIN_FUZZY_QUERY) {
    for (let i = 0; i < rows.length; i++) {
      if (fuzzyHit(haystacks[i]!, q)) {
        hits.push({ row: rows[i]!, rank: RANK_FUZZY, order: i });
      }
    }
  }

  return hits
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((h) => h.row);
}
