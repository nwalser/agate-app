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
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
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
    },
  },
);
