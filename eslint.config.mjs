import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * eslint.config.mjs — רושפינה.
 * הקרנל (kernel/) הוא מודול-חוץ נקי שאסור לשנות — לא לאכוף עליו חוקי-ריפו.
 */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // סביבת-קונסולה: פורמט חופשי, טיפוסים קפדניים בקוד שלנו בלבד.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "off",
      "no-irregular-whitespace": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "kernel/**",
      "kernel-smoke.ts",
      "src/components/ui/**",
      ".bridge/**",
      "public/**",
    ],
  },
];

export default eslintConfig;
