import { useEffect, useState } from "react";
import { ProfileEditForm } from "./ProfileEditForm";
import { UnauthenticatedHome } from "./UnauthenticatedHome";
import { useAuth } from "./AuthProvider";
import type { ProfileWithStats } from "../../shared/types";

export function ProfileView() {
  const { isAuthenticated, loading: authLoading, error: authError, login } = useAuth();
  const [profile, setProfile] = useState<ProfileWithStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState(false);
  // Bumped after a successful save to re-trigger the load effect below.
  const [reloadKey, setReloadKey] = useState(0);

  // Cancelled-flag guard matches AuthProvider.tsx's pattern -- a slow
  // request that resolves after the user navigates away must not setState
  // on an unmounted ProfileView.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/profile")
      .then((res) => (res.ok ? (res.json() as Promise<ProfileWithStats>) : null))
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, reloadKey]);

  const handleSave = async (displayName: string) => {
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (res.ok) {
      setSaveError(false);
      setReloadKey((k) => k + 1);
    } else {
      setSaveError(true);
    }
  };

  if (authLoading) return null;
  if (!isAuthenticated) return <UnauthenticatedHome onLogin={login} error={authError} />;
  if (loading) return <p>Loading profile…</p>;
  if (!profile) return <p>Unable to load profile.</p>;

  return (
    <div className="profile-view">
      <h1>Profile</h1>
      <p>{profile.email}</p>
      {profile.role && <p>Role: {profile.role}</p>}
      <p>Member of {profile.courseCount} course(s)</p>

      {profile.instructorStats && (
        <section>
          <h2>Instructor stats</h2>
          <p>Homeworks created: {profile.instructorStats.homeworksCreated}</p>
        </section>
      )}
      {profile.studentStats && (
        <section>
          <h2>Student stats</h2>
          <p>Submissions: {profile.studentStats.submissionsCount}</p>
          <p>Completed sections: {profile.studentStats.completedSections}</p>
        </section>
      )}

      {saveError && (
        <div role="alert" className="profile-save-error">
          <p>Failed to save your changes. Please try again.</p>
          <button type="button" onClick={() => setSaveError(false)}>
            Dismiss
          </button>
        </div>
      )}

      <ProfileEditForm initialDisplayName={profile.displayName} onSave={handleSave} />
    </div>
  );
}
