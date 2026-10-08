import { useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { ApiError, apiClient } from "../lib/api-client";
import type { ProvisionCourseResponse } from "@llteacher/ui/api";

export function CourseSetupView() {
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
  </div>;
}
