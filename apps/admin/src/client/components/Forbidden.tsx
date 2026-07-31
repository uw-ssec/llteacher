/* --------------------------------------------------------------------------
   Forbidden — branded 403 shown to an authenticated user who isn't an
   instructor/TA/admin for any course. Distinct from UnauthenticatedAdmin
   (no session at all) -- this is "you're signed in, but this console isn't
   for you" (issue #10: "students hitting it get a branded 403").
   -------------------------------------------------------------------------- */

export function Forbidden() {
  return (
    <div className="admin-forbidden">
      <div className="admin-forbidden__mark" aria-hidden="true">
        ¶
      </div>
      <h1>403 — Instructor console</h1>
      <p>
        This area is for teaching staff (TAs and instructional leads) and course admins. Your
        account doesn&apos;t currently hold one of those roles in any course.
      </p>
    </div>
  );
}
