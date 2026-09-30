import { defineConfig } from 'eslint/config';
import baseConfig from './.config/eslint.config.mjs';

export default defineConfig([
  {
    // generated or local-only files, as in .gitignore
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
      'playwright/.cache/',
      'playwright/.auth/',
      '**/logs/',
      '.claude/',
      'graphify-out/',
    ],
  },
  ...baseConfig,
  {
    // Functions are const arrow functions. Classes use normal methods, except methods that are passed around
    // unbound (callbacks), which are arrow-function fields. The files pattern also brings tests/*.ts and root .ts
    // files into lint.
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    ignores: ['.config/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'FunctionDeclaration', message: 'Use a const arrow function.' },
        {
          selector: 'FunctionExpression:not(MethodDefinition > FunctionExpression)',
          message: 'Use a const arrow function.',
        },
      ],
    },
  },
]);
