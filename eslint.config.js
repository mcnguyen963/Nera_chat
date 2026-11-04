// Flat config. The app stays build-free: ESLint only reads the sources.
// Existing violations live in eslint-suppressions.json (ESLint bulk suppressions);
// `npm run lint` fails only on new ones. Shrink it with `npm run lint:prune`.
import js from '@eslint/js';
import globals from 'globals';
import promise from 'eslint-plugin-promise';
import { importX } from 'eslint-plugin-import-x';

const shared = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-undef': 'error',
  'no-unreachable': 'error',
  eqeqeq: ['error', 'smart'],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-async-promise-executor': 'error',
  'promise/no-return-wrap': 'error',
  'promise/catch-or-return': ['error', { allowFinally: true, allowThen: true }],
  'promise/no-new-statics': 'error',
  'promise/valid-params': 'error',
  'promise/no-multiple-resolved': 'error',
  // Rejected after trial (noise, no defects found in samples): require-await (889 hits),
  // no-promise-executor-return (240), promise/param-names (86), promise/always-return (6),
  // import-x/no-duplicates (15).
};

export default [
  { ignores: ['node_modules/**', 'coverage/**', '_site/**', 'js/vendor/**', 'js/firebase-config.js', 'tests/fixtures/**', '.private/**', '.secret/**', 'production-reports/**', 'production-backups/**', 'lorebooks/**', 'play-history/**', 'investigate/**', 'data/**', 'docs/**', 'starting/**'] },
  js.configs.recommended,
  {
  files: ['js/**/*.js'],
  languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.browser } },
  plugins: { promise, 'import-x': importX },
  rules: {
  ...shared,
  'import-x/no-cycle': ['error', { ignoreExternal: true }],
  'import-x/no-unresolved': ['error', { ignore: ['^https://'] }],
  'import-x/named': 'error',
  'import-x/no-self-import': 'error',
  },
  },
  {
  files: ['js/tokenizer-worker.js'],
  languageOptions: { globals: { ...globals.worker } },
  },
  {
  files: ['tests/**/*.mjs', 'scripts/**/*.mjs', '*.js'],
  languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { ...globals.node } },
  plugins: { promise },
  rules: shared,
  },
  {
  // Callbacks serialised into a real browser page through CDP Runtime.evaluate.
  files: ['tests/settings-layout.mjs', 'tests/browser-embedding-maintenance.mjs', 'tests/tools/benchmark-*.mjs'],
  languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
