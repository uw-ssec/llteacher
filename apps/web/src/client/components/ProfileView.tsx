import { useEffect, useState } from "react";
import { ProfileEditForm } from "./ProfileEditForm";
import type { ProfileWithStats } from "../../shared/types";

export function ProfileView() {
  const [profile, setProfile] = useState<ProfileWithStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch("/api/profile")
      .then((res) => (res.ok ? (res.json() as Promise<ProfileWithStats>) : null))
      .then((data) => setProfile(data))
      .catch(() => setProfile(null))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async (displayName: string) => {
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (res.ok) load();
  };

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
        </section>
      )}

      <ProfileEditForm initialDisplayName={profile.displayName} onSave={handleSave} />
    </div>
  );
}
