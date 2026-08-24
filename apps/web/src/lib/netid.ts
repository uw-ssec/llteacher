/* --------------------------------------------------------------------------
   UW NetID validation (#210).

   `IdentityCipher.normalizeNetid` is only `trim().toLowerCase()` -- there was
   no format check anywhere in the tree, which was fine while NetIDs only ever
   arrived *derived from an authenticated email address* (deriveNetid, in
   UserIdentityService). #210 is the first path where a human types one, and
   an unchecked string typed by a human becomes a pending `users` row holding
   `netid_blind_index`, which is uniquely indexed.

   That asymmetry drives the rule below. The two ways to be wrong are not
   equally bad:

     · Too strict — a real TA is rejected. The instructor sees exactly which
       NetID was refused and why, on screen, and can escalate. Recoverable,
       and visible at the moment it happens.

     · Too loose — a typo ("adalovelace@uw.edu" pasted whole, or a name with
       a space) mints a junk pending user that permanently squats a unique
       index entry. Nothing in the product deletes it, and the next person
       who legitimately owns that NetID collides with a row they cannot see.

   So this is deliberately the strict, documented form of a *personal* UW
   NetID and nothing else.

   ---------------------------------------------------------------------------
   THIS IS A SHAPE CHECK, NOT AN IDENTITY CHECK. Deliberately.

   #210 says "get the actual rule from UW IT rather than inventing a regex."
   The rule below is the publicly documented form of a *personal* UW NetID --
   begins with a lowercase letter, 1-8 characters, letters and digits only --
   and it deliberately excludes the administrative and shared forms
   (`joe-admin`, departmental IDs), which are not people and should not be
   TAs on a course.

   Authoritative validation is not this function's job and will not become
   it: it lands with Canvas (#73's instructor API tokens, #74's roster
   import), where a NetID can be checked against a real enrolment rather
   than against a pattern. That is a strictly better answer than any regex,
   because "well-formed" and "a person who exists in this course" are
   different questions and only the second one matters.

   So what this buys in the meantime is narrow and worth stating: it stops a
   pasted `alovelace@uw.edu`, a name with a space, or an empty cell from
   minting a pending `users` row that permanently squats a uniquely-indexed
   `netid_blind_index`. A rejected valid TA is visible and recoverable -- the
   instructor sees which entry was refused and why. An accepted invalid one
   is neither.

   When #74 lands, the change here is to keep this as the cheap local guard
   and add the Canvas lookup above it in the provisioning pipeline, not to
   loosen the pattern. Both the regex and the sentence shown to the
   instructor live in this file, and every caller (#210's add-TA route,
   #32/#86's roster paths) reaches them through `isValidNetid`.
   -------------------------------------------------------------------------- */

/** Personal UW NetID: lowercase letter first, then up to 7 more lowercase
 *  letters or digits. Applied AFTER IdentityCipher.normalizeNetid, so the
 *  input is already trimmed and lowercased -- this pattern therefore does
 *  not need to admit uppercase. */
const PERSONAL_NETID_RE = /^[a-z][a-z0-9]{0,7}$/;

/** Shown to the instructor beside the NetID they typed. States the rule
 *  rather than saying "invalid", because the whole value of per-NetID
 *  results is telling them which of eight entries was the typo. */
export const NETID_RULE_MESSAGE =
  "Not a UW NetID. A NetID is 1–8 characters, starts with a letter, and contains only letters and numbers.";

/** True when `normalized` is a well-formed personal UW NetID. Takes an
 *  already-normalized value; callers that hold raw user input should run
 *  `IdentityCipher.normalizeNetid` first. */
export function isValidNetid(normalized: string): boolean {
  return PERSONAL_NETID_RE.test(normalized);
}

/** The email a NetID implies. UW NetIDs map bidirectionally to `@uw.edu`
 *  addresses -- `deriveNetid` already goes the other way for `uw.edu` and
 *  `*.uw.edu`, and mints the same string this produces. Kept here so the two
 *  directions of one mapping are not written in two files. */
export function emailForNetid(normalized: string): string {
  return `${normalized}@uw.edu`;
}
