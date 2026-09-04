import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks 7 added the React Compiler rules. A handful
      // of existing hooks and dialogs set state in an effect or write a ref
      // during render on purpose; they are warnings until each is reworked,
      // so CI reports them without blocking on them.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  {
    // shadcn primitives export their variant helpers next to the component,
    // and main.tsx is the entry point: neither is a fast-refresh boundary.
    files: ["src/components/ui/**/*.tsx", "src/main.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
])
