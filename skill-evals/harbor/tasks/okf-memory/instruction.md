Record in the project memory of the repository at `/app` that tenant isolation
is enforced by passing `courseId` into every homework repository query, because
a route that forgot it once returned another course's sections. This refines the
existing tenancy decision rather than replacing it.

Use the actor token `claude-code:test-model`.
