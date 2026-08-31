// ESLint 9 flat config —— Prettier 管格式，ESLint+typescript-eslint 管逻辑/约定。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // web/ 是独立子项目（React + Vite + npm 自带工具链），根 ESLint 只管 src/ 与 test/
  { ignores: ["dist/**", "node_modules/**", "output/**", "web/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-unused-private-class-members": "error",
      "no-console": "off",
    },
  },
);
