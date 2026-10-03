#!/usr/bin/env node
// Real backups (BRD 24, OB-06), not a placeholder: shells out to `docker exec` against the running
// Postgres/Mongo containers, using the same tools (`pg_dump`, `mongodump`) a production backup job would.
// Usage: node scripts/backup.mjs [outDir]
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_CONTAINER = process.env.PG_CONTAINER ?? 'shop-postgres-1';
const MONGO_CONTAINER = process.env.MONGO_CONTAINER ?? 'shop-mongo-1';
const outDir = process.argv[2] ?? 'backups';
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function run(label, args, outFile) {
  const start = Date.now();
  const result = spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
  writeFileSync(outFile, result.stdout);
  const ms = Date.now() - start;
  const size = statSync(outFile).size;
  console.log(`${label}: ${outFile} (${(size / 1024).toFixed(0)} KB) in ${ms}ms`);
  return { outFile, ms, size };
}

// pg_dump's custom format (-Fc): compressed, and the only format pg_restore can target selectively
// (single tables, parallel restore) — plain SQL dumps can't do either.
const pg = run('postgres backup', ['exec', PG_CONTAINER, 'pg_dump', '-U', 'ecommerce', '-Fc', 'ecommerce'], join(outDir, `postgres-${stamp}.dump`));

// --archive streams the whole database (every collection) as one file; --gzip keeps it small.
const mongo = run('mongo backup', ['exec', MONGO_CONTAINER, 'mongodump', '--archive', '--gzip', '--db=ecommerce_catalog'], join(outDir, `mongo-${stamp}.archive.gz`));

console.log(`\nBackup complete: ${pg.outFile}, ${mongo.outFile}`);
