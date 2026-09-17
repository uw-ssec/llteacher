# Markdown cleanup validation — 2026-09-17

Implemented instructor-triggered GPT-5.4 Mini / low-effort cleanup, remark GFM/math
normalization, rendered preview, line diff, fidelity warnings, Apply/Discard,
optimistic concurrency on Apply, and persistent original-body recovery.

## Checks

- Admin: 301 tests passed.
- Web: 2,096 tests passed; six optional S3 tests skipped.
- Both TypeScript projects and production builds passed.
- Browser: opened the real Problem Set 1 in the isolated review app, invoked
  cleanup and inspected proposal text, warnings, table structure and diff controls
  through the browser accessibility tree. Native browser automation intermittently
  returned stale state / noWindowsAvailable; final persistence checks used the API.
- Authenticated API on isolated localhost:2413, course
  eeeeeeee-2222-4222-8222-222222222222:
  - `ali-econ-201/problem-sets/ali-econ-201-problem-sets-problem-set-1`
  - Proposal 200, 8,260 source characters → 8,890 proposed characters.
  - Apply 200; subsequent GET retained original body exactly.
  - Stale expected-body write rejected with 409.
  - Search for Simpleland returned the cleaned concept.
- Review fixture retains the cleaned document and its preserved original.

## Limits

Cleanup supports 60,000 characters per request with a two-minute model timeout.
Parsing and numeric comparison do not guarantee semantic fidelity. Instructors
review the diff and ambiguous formulas/tables before applying. Original text is
captured at the first edit after installation; historical versions cannot be
reconstructed. Originals live outside the searchable bundle and must be backed up
with the course directory.
