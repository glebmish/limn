import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'build/**', '.worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Allow intentionally-unused identifiers when prefixed with _ (common for
    // ignored destructures / callback args).
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/server/**/*.ts', 'src/cli/**/*.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['bin/**/*.js'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // openDb() (src/main/db/db.ts) is the sole `node:sqlite` entrypoint: it sets
    // WAL, busy_timeout, the integrity check, and runs migrations. Forbid value
    // imports of node:sqlite everywhere else in src/ so no future code can bypass
    // it with a raw `new DatabaseSync()`. Type-only imports (`import type`) stay
    // allowed — many DAO files import the `DatabaseSync` type.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/db/db.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{
          name: 'node:sqlite',
          message: 'Open the database through openDb() (src/main/db/db.ts) — it sets WAL, busy_timeout, integrity check, and runs migrations. Type-only imports are fine.',
          allowTypeImports: true
        }]
      }]
    }
  }
)
