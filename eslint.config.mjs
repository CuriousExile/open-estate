import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/cdk.out/**',
      '**/.angular/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Angular SPA runs in the browser.
    files: ['packages/frontend/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // shared must stay free of AWS and of other workspace packages (usable by the frontend).
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@aws-sdk/*',
                'aws-sdk',
                'aws-cdk-lib',
                'aws-cdk-lib/*',
                '@aws-lambda-powertools/*',
              ],
              message: '@open-estate/shared must not depend on AWS.',
            },
            {
              // Self-imports are fine (test arbitraries import the package by name).
              group: ['@open-estate/*', '!@open-estate/shared'],
              message: '@open-estate/shared must not depend on other workspace packages.',
            },
          ],
        },
      ],
    },
  },
  {
    // The `z` object (named or default export) bundles all of zod incl. every locale; the
    // namespace import stays tree-shakeable for the frontend bundle. Type-only imports are fine.
    files: ['packages/shared/src/**/*.ts', 'packages/frontend/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='zod'][importKind!='type'] > :matches(ImportDefaultSpecifier, ImportSpecifier[imported.name='z'][importKind!='type'])",
          message: "Use `import * as z from 'zod'` (tree-shakeable).",
        },
      ],
    },
  },
  prettier,
);
