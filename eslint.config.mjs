import { defineConfig } from "eslint/config";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  {
    ignores: [
      "artifacts/**",
      "benchmark/**",
      "docs/**",
      "main.js",
      "main.js.map",
      "mcp-server/**",
      "node_modules/**",
      "release/**",
      "src/api/remote/**",
      "test/**",
      ".obsidian/**",
      "embedding-worker.js",
      "embedding-worker.js.map",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["main.ts", "src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        __ANALOGY_BUILD_ID__: "readonly",
        __ANALOGY_EMBEDDING_WORKER_SOURCE__: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "warn",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { args: "none", ignoreRestSiblings: true },
      ],
      "depend/ban-dependencies": "warn",
      "no-empty": "warn",
      "no-prototype-builtins": "off",
      "no-useless-catch": "warn",
      "no-useless-escape": "warn",
      "no-unused-vars": "off",
      "obsidianmd/rule-custom-message": "warn",
    },
  },
  {
    files: ["package.json"],
    rules: {
      "depend/ban-dependencies": "warn",
    },
  },
]);
