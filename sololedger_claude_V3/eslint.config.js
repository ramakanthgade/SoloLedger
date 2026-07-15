import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  // Scope linting to the client source only. The server/ dir has its own
  // tsconfig and is out of scope here.
  {
    ignores: ['dist', 'dev-dist', 'node_modules', 'server', '*.config.js', '*.config.ts']
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // The codebase carries eslint-disable directives targeting rules from a
    // previous config that are out of scope here; don't flag them as unused.
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Underscore-prefixed args/vars are intentional throwaways.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // These are widely used across the existing codebase; keep them as
      // warnings so lint stays useful without demanding a mass rewrite.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      // Newer, stylistic/experimental rules from ESLint 10 core and
      // react-hooks 7. Useful signal, but too noisy to gate the build on for
      // the existing codebase — surfaced as warnings rather than errors.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn'
    }
  },
  // Test files use vitest globals.
  {
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  }
);
