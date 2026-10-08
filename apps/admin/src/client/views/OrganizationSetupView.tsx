import { useState } from "react";
import { ApiError, apiClient } from "../lib/api-client";

export function OrganizationSetupView({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [domains, setDomains] = useState("uw.edu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await apiClient.platformOrganization.create({
        name: name.trim(), slug: slug.trim(),
        allowedDomains: domains.split(",").map((domain) => domain.trim()).filter(Boolean),
      }, { signal: null });
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create the institution.");
    } finally { setBusy(false); }
  }

  return (
    <main className="admin-view" style={{ maxWidth: 720, margin: "64px auto" }}>
      <p className="page-header__eyebrow">FIRST-RUN SETUP</p>
      <h1>Set up your institution</h1>
      <p className="admin-form-hint">This creates LLTeacher's local institution. It does not change WorkOS.</p>
      <form className="admin-accession" onSubmit={submit}>
        <label className="admin-accession__label" htmlFor="org-name">Institution name</label>
        <input id="org-name" className="admin-accession__field" required value={name} onChange={(e) => setName(e.target.value)} placeholder="University of Washington" />
        <label className="admin-accession__label" htmlFor="org-slug">Slug</label>
        <input id="org-slug" className="admin-accession__field" required pattern="[a-z0-9-]+" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="uw" />
        <label className="admin-accession__label" htmlFor="org-domains">Allowed email domains</label>
        <input id="org-domains" className="admin-accession__field" required value={domains} onChange={(e) => setDomains(e.target.value)} aria-describedby="org-domains-hint" />
        <p id="org-domains-hint" className="admin-accession__hint">Comma-separated, for example uw.edu, washington.edu.</p>
        <div className="admin-accession__actions"><button className="admin-accession__submit" disabled={busy}>{busy ? "Creating…" : "Create institution"}</button></div>
        {error && <div className="admin-alert" role="alert">{error}</div>}
      </form>
    </main>
  );
}
