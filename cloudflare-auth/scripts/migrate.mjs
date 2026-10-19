import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const tables = ['accounts', 'sessions', 'profile_media', 'servers', 'server_members', 'server_invites'];
const required = {
  accounts: ['id', 'email', 'nick', 'nick_lower', 'avatar_url', 'created_at', 'updated_at'],
  sessions: ['token_hash', 'account_id', 'created_at', 'expires_at'],
  profile_media: ['account_id', 'kind', 'hash', 'mime', 'size', 'data', 'updated_at'],
  servers: ['id', 'name', 'owner_account_id', 'created_at'],
  server_members: ['server_id', 'account_id', 'joined_at'],
  server_invites: ['code', 'server_id', 'created_by', 'created_at', 'expires_at', 'max_uses', 'uses']
};
const files = ['schema.sql', '../cloudflare/migrations/0001_servers.sql', 'migrations/0002_profile.sql', 'migrations/0003_media.sql', 'migrations/0004_password.sql'];
const statements = file => readFileSync(resolve(root, file), 'utf8').replace(/--[^\n]*/g, '')
  .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

// Snapshot contains only schema metadata, never account/session contents.
export function planMigrations(snapshot) {
  const objects = new Set(snapshot.objects.map(o => o.name));
  const columns = Object.fromEntries(tables.map(t => [t, new Set(snapshot.columns[t] || [])]));
  for (const table of tables) {
    if (objects.has(table) && required[table].some(c => !columns[table].has(c))) {
      throw new Error(`Unexpected existing schema for ${table}; review required, no automatic repair.`);
    }
  }
  const plan = [];
  const existingTables = new Set(snapshot.objects.filter(o => o.type === 'table').map(o => o.name));
  for (const file of files) {
    for (const sql of statements(file)) {
      const create = sql.match(/^CREATE (TABLE|INDEX) IF NOT EXISTS (\w+)\b/i);
      const alter = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)\b/i);
      if (create) {
        if (!objects.has(create[2])) { plan.push({ file, sql }); objects.add(create[2]); }
      } else if (alter) {
        if (!existingTables.has(alter[1])) continue; // fresh CREATE already has all columns
        if (!columns[alter[1]].has(alter[2])) {
          plan.push({ file, sql }); columns[alter[1]].add(alter[2]);
        }
      } else throw new Error(`Non-additive/unrecognized SQL in ${file}; manual review required.`);
    }
  }
  return plan;
}

export async function inspectSchema(query) {
  const objects = await query("SELECT name,type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'");
  const columns = {};
  for (const table of tables) columns[table] = (await query(`PRAGMA table_info(${table})`)).map(c => c.name);
  return { objects, columns };
}

function runCli(args) {
  const remote = args.includes('--remote'), local = args.includes('--local'), apply = args.includes('--apply');
  if (remote === local || args.some(a => !['--remote', '--local', '--apply'].includes(a))) {
    throw new Error('Usage: node scripts/migrate.mjs (--remote | --local) [--apply]. Default: plan only.');
  }
  const runQuery = sql => {
    const processResult = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'd1', 'execute', 'triscord-accounts', remote ? '--remote' : '--local', '--json', '--command', sql], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024
    });
    if (processResult.error || processResult.status !== 0) {
      throw new Error(processResult.error?.message || processResult.stderr || 'Wrangler query failed');
    }
    const result = JSON.parse(processResult.stdout);
    if (!Array.isArray(result) || result.some(r => !r.success)) throw new Error('D1 query failed');
    return result[0].results;
  };
  return (async () => {
    const plan = planMigrations(await inspectSchema(runQuery));
    console.log(JSON.stringify({ target: remote ? 'remote' : 'local', mode: apply ? 'apply' : 'plan', pending: plan.length, statements: plan }, null, 2));
    if (!apply) return;
    for (const { sql } of plan) runQuery(sql);
    const remaining = planMigrations(await inspectSchema(runQuery));
    if (remaining.length) throw new Error('Migration incomplete; inspect schema and rerun. No rollback/destructive SQL was attempted.');
    console.log('PASS: additive migration complete; no pending schema changes');
  })();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
