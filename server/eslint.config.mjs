import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "*.tsbuildinfo"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Untyped JSON from web APIs is deliberately `any`.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
