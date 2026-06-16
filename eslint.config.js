// Flat ESLint config (ESLint 9 + typescript-eslint).
//
// The bug-class rules below are ERRORS, not warnings — a new violation fails the
// `npm run check` gate. They encode the non-negotiables in CLAUDE.md: no `any` in
// IPC/storage/crypto code, no empty catch blocks, every error handled.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'target/**',
      'node_modules/**',
      'src-tauri/**',
      '**/*.config.*',
      'eslint.config.js',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      // projectService loads type information so the type-aware rules below work
      // (no-floating-promises etc. need to know which expressions are Promises).
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // TS owns these — the JS-only versions throw false positives on TS syntax.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
      // SolidJS refs (`let el; <div ref={el}/>`) look unassigned to ESLint.
      'no-unassigned-vars': 'off',

      'no-useless-escape': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Type-aware rules (need projectService above). A password manager is full
      // of async IPC — an unawaited unlock/lock/save/sync that rejects must never
      // vanish silently. `void expr` is the explicit "fire and forget" opt-out.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // Closed unions (ItemType, ConnectionKind, …) must handle every case — the
      // CLAUDE.md rule, enforced.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
);
