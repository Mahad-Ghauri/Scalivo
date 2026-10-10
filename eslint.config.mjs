import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `ponytail/` is a third-party plugin checked out here and gitignored — not ours to lint.
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      'app/**',
      'ponytail/**',
      'Social App Login Flutter Implementation/**',
      'web/next-env.d.ts',
    ],
  },
  // Browser reference bundles and Next's generated declaration are not authored source.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
      },
    },
  },
  { files: ['web/scripts/*.mjs'], languageOptions: { globals: { console: 'readonly' } } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The messaging abstraction exists so the provider is swappable. Nothing
    // above it may import OpenWA directly — that is a Phase 0 definition of
    // done, so it is enforced here rather than left to review.
    files: ['backend/src/**/*.ts'],
    ignores: ['backend/src/messaging/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/OpenWAProvider*', '**/openwa/**'],
              message:
                'Business logic must go through MessagingProvider. Only backend/src/messaging may import a concrete provider.',
            },
          ],
        },
      ],
    },
  },
);
