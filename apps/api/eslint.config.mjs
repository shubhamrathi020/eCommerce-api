import baseConfig from '../../eslint.config.mjs';

export default [
  // Prisma-generated client: regenerated code, never hand-edited or linted.
  { ignores: ['generated/**'] },
  ...baseConfig,
];
