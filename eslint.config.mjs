import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow `const { omitted, ...rest } = obj` to drop a field.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
);
