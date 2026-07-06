import html from '@html-eslint/eslint-plugin';

export default [
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  {
    ...html.configs['flat/recommended'],
    files: ['**/*.html'],
    rules: {
      ...html.configs['flat/recommended'].rules,
      // The app is a single hand-authored file; keep structural checks that catch
      // real bugs (duplicate ids, unclosed tags, bad nesting) and relax purely
      // stylistic ones that Prettier owns.
      '@html-eslint/require-closing-tags': 'off',
      '@html-eslint/no-extra-spacing-attrs': 'off',
      '@html-eslint/attrs-newline': 'off',
      '@html-eslint/indent': 'off',
    },
  },
];
