import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Flat ESLint config for the Vite + Hono app (post-Next migration). Replaces the
// old next/core-web-vitals + next/typescript extends. We re-register
// eslint-plugin-react-hooks explicitly and enable the same react-hooks rules the
// source was written against (rules-of-hooks, exhaustive-deps, set-state-in-effect,
// refs) — the code carries targeted `eslint-disable react-hooks/...` directives
// for those, so they must resolve and be enabled or the directives would warn.
//
// Registering the plugin via `plugins:` (rather than the plugin's own
// `recommended-latest` config) keeps the full React-Compiler ruleset *available*
// (so the directives resolve) without turning on the parts of it the code hasn't
// been vetted against.
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "dist/**",
      "node_modules/**",
      "scripts/**",
      "cloud-browser/**",
      "cloud-agent-runner/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/refs": "error",
      // `_`-prefixed args/vars are deliberately unused (placeholder params,
      // destructure-and-drop) — matches the prior config's convention.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // Empty catch blocks are an intentional "ignore errors" idiom here.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
