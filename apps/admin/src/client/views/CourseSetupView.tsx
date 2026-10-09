import { useRef, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { ApiError, apiClient } from "../lib/api-client";
import type { PlatformCourseListItem, ProvisionCourseResponse } from "@llteacher/ui/api";
import { useApiResource } from "../lib/useApiResource";
import { ViewEmpty, ViewError, ViewLoading } from "../components/ViewState";

function AddCourseInstructor({ course, onAdded }: { course: PlatformCourseListItem; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputId = `add-instructor-${course.id}`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await apiClient.platformCourses.addInstructor(course.id, { instructorEmail: email }, { signal: null });
      setSuccess(result.membershipAdded
        ? `${result.instructor.email} is now an instructor for ${course.code}.`
        : `${result.instructor.email} is already an instructor for ${course.code}.`);
      setEmail("");
      onAdded();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not add the instructor.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <>
    {open ? <form className="admin-accession" aria-label={`Add instructor to ${course.title}`} onSubmit={submit}>
      <label className="admin-accession__label" htmlFor={inputId}>Instructor email for {course.code} ({course.term})</label>
      <input id={inputId} className="admin-accession__field" type="email" required disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} />
      <div className="admin-accession__actions">
        <button className="admin-accession__submit" disabled={busy}>{busy ? "Adding…" : "Add instructor"}</button>
        <button className="admin-button admin-button--ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <div className="admin-alert" role="alert">{error}</div>}
    </form> : <button className="admin-button" type="button" aria-label={`Add instructor to ${course.title}`} onClick={() => setOpen(true)}>Add instructor</button>}
    {success && <p className="admin-form-hint" role="status">{success}</p>}
  </>;
}

export function CourseSetupView() {
  const coursesResource = useApiResource((opts) => apiClient.platformCourses.list(opts), []);
  const [form, setForm] = useState({ instructorEmail: "", title: "", code: "", term: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ProvisionCourseResponse | null>(null);
  const field = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((value) => ({ ...value, [key]: event.target.value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setCreated(null);
    try {
      setCreated(await apiClient.platformCourses.create(form, { signal: null }));
      setForm({ instructorEmail: "", title: "", code: "", term: "" });
      coursesResource.reload();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : "Could not create the course."); }
    finally { setBusy(false); }
  }
  return <div className="admin-view">
    <PageHeader eyebrow="SUPER ADMIN" title="Course Setup" />
    <p className="admin-form-hint">Create the LLTeacher course shell and assign its instructor. Canvas can be linked later by the instructor.</p>
    <form className="admin-accession" onSubmit={submit}>
      {([['instructorEmail','Instructor email','email'],['title','Course title','text'],['code','Course code','text'],['term','Term','text']] as const).map(([key,label,type]) => <div key={key}>
        <label className="admin-accession__label" htmlFor={`course-${key}`}>{label}</label>
        <input id={`course-${key}`} className="admin-accession__field" type={type} required value={form[key]} onChange={field(key)} />
      </div>)}
      <div className="admin-accession__actions"><button className="admin-accession__submit" disabled={busy}>{busy ? "Creating…" : "Create course"}</button></div>
      {error && <div className="admin-alert" role="alert">{error}</div>}
      {created && <p className="admin-form-hint" role="status">Created {created.course.code}: {created.course.title}. {created.instructor.email} can sign in and run the course.</p>}
    </form>
    <section aria-labelledby="all-courses-heading">
      <h2 id="all-courses-heading">All courses</h2>
      {coursesResource.loading && !coursesResource.data ? <ViewLoading label="Loading courses…" /> : null}
      {coursesResource.error ? <ViewError error={coursesResource.error} onRetry={coursesResource.reload} detail="GET /api/platform/courses" /> : null}
      {coursesResource.data?.courses.length === 0 ? <ViewEmpty title="No courses yet" body="Create the first course shell above." /> : null}
      {coursesResource.data?.courses.length ? <table className="admin-table">
        <caption className="admin-visually-hidden">All LLTeacher course shells</caption>
        <thead><tr><th scope="col">Course</th><th scope="col">Code</th><th scope="col">Term</th><th scope="col">Status</th><th scope="col">Instructors</th><th scope="col">Actions</th></tr></thead>
        <tbody>{coursesResource.data.courses.map((course) => <tr key={course.id}>
          <th scope="row">{course.title}</th>
          <td>{course.code}</td>
          <td>{course.term}</td>
          <td>{course.status === "active" ? "Active" : "Inactive"}</td>
          <td>{course.instructors.length ? course.instructors.map((instructor) => <div key={instructor.userId}>{instructor.email}</div>) : "—"}</td>
          <td><AddCourseInstructor course={course} onAdded={coursesResource.reload} /></td>
        </tr>)}</tbody>
      </table> : null}
    </section>
  </div>;
}
