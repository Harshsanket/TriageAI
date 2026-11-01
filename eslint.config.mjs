import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'perf/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/ai-service/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Phase 21 R23: hosted egress and registry/trace exports must go through
    // EgressClient (allowlist + SSRF checks); local model runtimes are exempt.
    files: [
      'apps/api/src/services/chatModels.ts',
      'apps/api/src/services/plugins.ts',
      'packages/kernel/src/models/trace.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            'Use the EgressClient capability (or a justified eslint-disable for local runtimes) instead of raw fetch.',
        },
      ],
    },
  },
  {
    // Phase 18.3: stage handlers must not start workflows directly; use a
    // declared graph/subworkflow node instead.
    files: ['modules/*/src/stages/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='startWorkflow']",
          message:
            'Stage handlers must not start workflows directly; declare a subworkflow/event edge.',
        },
      ],
    },
  },
  {
    // Phase 10C.T3: request/stage paths must use typed AppError factories.
    files: ['modules/*/src/**/*.ts', 'apps/api/src/routes/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Error']",
          message:
            'Use a typed AppError factory (notFound, conflict, invalid, dependencyUnavailable, timeout, rateLimited, policyBlocked, internal) instead of new Error.',
        },
        {
          selector: "CallExpression[callee.property.name='chat']",
          message:
            'Call models through callModel (limits, repair, fallbacks, trace), not ChatModel.chat directly.',
        },
      ],
    },
  },
);
