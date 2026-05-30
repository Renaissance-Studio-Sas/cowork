// ESLint 9 flat config. The previous setup pulled next/core-web-vitals through
// FlatCompat (the legacy eslintrc loader), which crashed resolving
// eslint-config-next's circular plugin graph ("Converting circular structure
// to JSON"). eslint-config-next 16 ships a ready-made flat-config array, so we
// spread it directly and skip the compat layer entirely.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // Standalone Node sub-projects and generated output — not part of the
    // Next app's source. Mirrors tsconfig's `exclude`.
    ignores: [
      ".next/**",
      "cloud-agent-runner/**",
      "cloud-browser/**",
      "scripts/**",
    ],
  },
  // Mirrors the previous `next/core-web-vitals` + `next/typescript` extends.
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Treat `_`-prefixed args/vars as deliberately unused (placeholder
      // params, destructure-and-drop), matching common convention.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default eslintConfig;
