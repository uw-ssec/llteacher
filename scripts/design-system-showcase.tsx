import { createRoot } from "react-dom/client";
import { Badge, Button, Input, Spinner, TopNav } from "@llteacher/ui";
import "@llteacher/ui/styles.css";

function DesignSystemShowcase() {
  return (
    <>
      <TopNav homework="Design-system review" userInitials="VR" isAuthenticated onProfileClick={() => {}} onLogout={() => {}} />
      <main className="conversation-inner">
        <h1>Shared component states</h1>
        <div className="admin-form">
          <Input label="Display name" required helperText="Your name appears in the course." defaultValue="Visual Reviewer" />
          <Input label="Email address" error="Enter a university email address." defaultValue="reviewer" />
          <fieldset className="admin-form-record">
            <legend>Actions</legend>
            <Button leadingIcon="+">Add section</Button>
            <Button trailingIcon="→" outlined variant="accent">Continue</Button>
            <Button loading>Saving</Button>
            <Button disabled variant="danger">Delete</Button>
          </fieldset>
          <fieldset className="admin-form-record">
            <legend>Status labels</legend>
            {(["neutral", "accent", "success", "warning", "danger"] as const).map((variant) => (
              <div key={variant}>
                <Badge variant={variant} size="sm">{variant}</Badge>
                <Badge variant={variant} size="md" outlined>{variant}</Badge>
              </div>
            ))}
          </fieldset>
          <fieldset className="admin-form-record">
            <legend>Loading indicators</legend>
            <Spinner size="sm" label="Small loading indicator" />
            <Spinner size="md" label="Medium loading indicator" />
            <Spinner size="lg" label="Large loading indicator" />
          </fieldset>
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<DesignSystemShowcase />);
