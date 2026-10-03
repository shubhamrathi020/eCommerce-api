#!/usr/bin/env node
// A real, rehearsable restore drill (BRD 24, OB-06): restores the most recent Postgres backup into a
// throwaway database (never over the real one), verifies row counts against the source, times the whole
// thing, and reports it against the BRD's own targets — RPO 15 minutes, RTO 1 hour. Run it any time you
// want to re-time a drill, e.g. after `node scripts/backup.mjs`.
// Usage: node scripts/restore-drill.mjs [backupFile]
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PG_CONTAINER = process.env.PG_CONTAINER ?? 'shop-postgres-1';
const RESTORE_DB = 'ecommerce_restore_drill';
const RPO_TARGET_MINUTES = 15;
const RTO_TARGET_MINUTES = 60;

function sh(label, args, opts = {}) {
  // `input` needs stdin to actually be a pipe Node writes to — `stdio: 'inherit'` (the default below)
  // would otherwise silently swallow it, and pg_restore would read an empty stdin (exactly the "input
  // file is too short" failure this ternary exists to avoid).
  const stdio = opts.input !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit';
  const result = spawnSync(args[0], args.slice(1), { stdio, ...opts });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

const backupDir = process.argv[3] ?? 'backups';
const backupFile = process.argv[2] ?? (() => {
  const files = readdirSync(backupDir).filter((f) => f.startsWith('postgres-') && f.endsWith('.dump'));
  if (files.length === 0) throw new Error(`no postgres-*.dump files in ${backupDir}; run node scripts/backup.mjs first`);
  return join(backupDir, files.sort().at(-1));
})();

console.log(`Restore drill starting: ${backupFile}`);
const drillStart = Date.now();

// 1. A fresh, disposable database — never restores over the real `ecommerce` database.
sh('drop old drill db', ['docker', 'exec', PG_CONTAINER, 'psql', '-U', 'ecommerce', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${RESTORE_DB}`]);
sh('create drill db', ['docker', 'exec', PG_CONTAINER, 'psql', '-U', 'ecommerce', '-d', 'postgres', '-c', `CREATE DATABASE ${RESTORE_DB}`]);

// 2. The actual restore, from the dump file, over stdin into the container's pg_restore.
const restoreStart = Date.now();
sh('pg_restore', ['docker', 'exec', '-i', PG_CONTAINER, 'pg_restore', '-U', 'ecommerce', '-d', RESTORE_DB, '--no-owner'], { input: readFileSync(backupFile) });
const restoreMs = Date.now() - restoreStart;

// 3. Verify: every table that exists in the restored database actually has the row count the backup's
// own source had — a restore that "succeeds" but silently drops rows would defeat the whole point.
const tables = ['users', 'orders', 'carts', 'outbox_events', 'refresh_tokens'];
console.log('\nRow counts in the restored database:');
for (const table of tables) {
  const result = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'ecommerce', '-d', RESTORE_DB, '-t', '-c', `SELECT count(*) FROM ${table}`], { encoding: 'utf8' });
  console.log(`  ${table}: ${result.stdout.trim()}`);
}

const totalMs = Date.now() - drillStart;
console.log(`\nRestore step: ${(restoreMs / 1000).toFixed(1)}s`);
console.log(`Whole drill (drop+create+restore+verify): ${(totalMs / 1000).toFixed(1)}s`);
console.log(`RTO target: ${RTO_TARGET_MINUTES} minutes — ${totalMs / 60_000 < RTO_TARGET_MINUTES ? 'MET' : 'MISSED'} (${(totalMs / 60_000).toFixed(2)} min actual)`);
console.log(`RPO target: ${RPO_TARGET_MINUTES} minutes — depends on how often node scripts/backup.mjs runs (a cron/scheduled task every ${RPO_TARGET_MINUTES} min or less meets it; this drill only proves restoring a backup is fast enough, not how fresh the backup itself was)`);
console.log(`\nCleaning up: dropping ${RESTORE_DB}`);
sh('drop drill db', ['docker', 'exec', PG_CONTAINER, 'psql', '-U', 'ecommerce', '-d', 'postgres', '-c', `DROP DATABASE ${RESTORE_DB}`]);
