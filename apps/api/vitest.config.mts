import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// Nest's dependency injection reads decorator metadata, which Vite's default transform (esbuild) does not emit;
// SWC does. Integration tests run against a real PostgreSQL database (see test/global-setup.ts).
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    name: 'api',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,test}/**/*.{test,spec}.ts'],
    globalSetup: ['test/global-setup.ts'],
    // One database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/api',
      provider: 'v8' as const,
    },
  },
}));
