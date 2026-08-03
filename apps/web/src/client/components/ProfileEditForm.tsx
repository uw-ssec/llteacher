import { useState, type FormEvent } from "react";
import { Button, Input } from "@llteacher/ui";

interface ProfileEditFormProps {
  initialDisplayName: string | null;
  onSave: (displayName: string) => Promise<void>;
}

export function ProfileEditForm({ initialDisplayName, onSave }: ProfileEditFormProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(displayName);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Edit profile">
      <Input
        label="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        disabled={saving}
      />
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
