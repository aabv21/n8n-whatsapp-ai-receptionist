import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['node_modules/', '.n8n-import/', '.superpowers/', 'docs/diagrams/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Tests read fixtures by computed path and index them by computed key.
    files: ['tests/**'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    // The Code-node sandbox has neither Node builtins nor fetch, and Luxon must stay a global
    // (see src/globals.d.ts) so esbuild doesn't bundle it into the generated jsCode.
    files: ['src/nodes/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['luxon'], patterns: ['node:*'] }],
      'no-restricted-globals': ['error', 'process', 'fetch'],
    },
  },
]);
