// Prisma 7 config: connection details live here (never in the schema file), read from the environment.
// Used by the Prisma CLI (migrate, studio, ...); the running app builds its own adapter, see
// `apps/api/src/app/prisma/prisma.service.ts`.
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// `pnpm exec` (and some IDE terminals) can run this with the workspace root as the process cwd
// rather than this directory, so resolve `.env` relative to this file instead of trusting cwd.
config({ path: resolve(import.meta.dirname, '.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
