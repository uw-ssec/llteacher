import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["**/*.test.{ts,tsx}"] },
  {
    files: ["apps/*/src/client/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { shadcn, "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    settings: {
      shadcn: {
        ui: "@llteacher/ui",
        note: "See docs/design-system/ and packages/ui/styles.css.",
      },
    },
    rules: {
      "shadcn/no-restyle": ["error", {
        allow: ["layout"],
        contracts: [
          { pattern: "^Button$", allow: ["layout", "btn--restart", "admin-form-record__remove"] },
          { pattern: "^EditableTitle$", allow: ["layout", "tutor-conversation-item__title"] },
        ],
      }],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": ["error", {
        allow: [
          "admin-banner--degraded",
          "admin-knowledge__tree-item",
          "admin-knowledge__search",
          "admin-knowledge__scope-name",
          "admin-knowledge__results",
          "admin-empty__icon",
          "admin-roster-table",
          "admin-transcript-detail",
          "tutor-conversation-item__time",
          "response-feedback",
          "response-feedback__trigger",
          "conversation-log",
          "conversation-error-row__unrestored",
          "conversation-error-row__unrestored-text",
          "editable-title__pencil",
          "md-pre",
          "message__student-text",
          "message__sources-item",
          "message__sources-title",
        ],
      }],
      "shadcn/require-static-classes": "error",
    },
  },
  {
    files: ["packages/ui/src/components/**/*.{ts,tsx}"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
    },
  },
];
