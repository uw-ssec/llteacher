import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
const filePath = "apps/web/src/client/design-system-probe.tsx";

test("design-system enforcement rejects each kind of visual drift", async () => {
  const examples = [
    ["shadcn/no-restyle", '<Button className="p-8">Save</Button>'],
    ["shadcn/no-raw-colors", '<div className="text-red-500" />'],
    ["shadcn/no-arbitrary-values", '<div className="p-[13px]" />'],
    ["shadcn/no-inline-styles", '<div style={{ color: "red" }} />'],
    ["shadcn/no-unknown-classes", '<div className="flex-cols" />'],
    ["shadcn/require-static-classes", '<Button className={getClasses()} />'],
  ];
  for (const [ruleId, markup] of examples) {
    const [result] = await eslint.lintText(`import { Button } from "@llteacher/ui"; export const Probe = () => (${markup});`, { filePath });
    assert.ok(result.messages.some((message) => message.ruleId === ruleId && message.severity === 2), `${ruleId} must reject ${markup}`);
  }
});

test("the shared theme, custom CSS, and component contracts resolve", async () => {
  const [result] = await eslint.lintText(`
    import { Button } from "@llteacher/ui";
    export const Probe = () => <div className="page-frame bg-bg text-text account-page">
      <Button variant="danger" className="btn--restart">Restart</Button>
      <Button className="mt-4">Save</Button>
      <article className="admin-record-row" style={{ "--row-delay": "40ms" }} />
    </div>;
  `, { filePath });
  assert.deepEqual(result.messages, []);
});

test("component implementations still reject raw colors and inline styles", async () => {
  const [result] = await eslint.lintText('export const Probe = () => <div className="bg-red-500" style={{ color: "red" }} />;', { filePath: "packages/ui/src/components/design-system-probe.tsx" });
  for (const ruleId of ["shadcn/no-raw-colors", "shadcn/no-inline-styles"]) {
    assert.ok(result.messages.some((message) => message.ruleId === ruleId));
  }
});
