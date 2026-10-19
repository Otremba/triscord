import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { inspectSchema, planMigrations } from '../scripts/migrate.mjs';

for (const scenario of ['empty', 'legacy', 'partial']) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    scriptPath: resolve('out/worker.js'), modules: true, compatibilityDate: '2026-10-12',
    host: '127.0.0.1', port: 0, d1Databases: { DB: `migration-${scenario}` }
  }));
  try {
    const db = await mf.getD1Database('DB');
    const query = async sql => (await db.prepare(sql).all()).results;
    if (scenario !== 'empty') {
      await db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL,nick TEXT,nick_lower TEXT UNIQUE,avatar_url TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
      await db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)').bind('existing', 'private@example.com', 'Nick', 'nick', null, 1, 1).run();
      if (scenario === 'partial') {
        await db.exec('ALTER TABLE accounts ADD COLUMN bio TEXT');
        await db.prepare('UPDATE accounts SET bio=?').bind('Preserve existing bio').run();
      }
    }
    const plan = planMigrations(await inspectSchema(query));
    assert(plan.length > 0);
    for (const { sql } of plan) await db.prepare(sql).run();
    assert.deepEqual(planMigrations(await inspectSchema(query)), []);
    // Test actual Worker endpoints against the migrated database.
    assert.equal((await mf.dispatchFetch('http://localhost/profile/unknown')).status, 404);
    if (scenario !== 'empty') {
      const existing = await db.prepare('SELECT * FROM accounts WHERE id=?').bind('existing').first();
      assert.equal(existing.email, 'private@example.com');
      assert.equal(existing.nick, 'Nick');
      assert.equal(existing.avatar_custom, 0);
      if (scenario === 'partial') assert.equal(existing.bio, 'Preserve existing bio');
    }
    const broken = await inspectSchema(query);
    broken.columns.sessions = ['token_hash'];
    assert.throws(() => planMigrations(broken), /Unexpected existing schema/);
  } finally { await mf.dispose(); }
}
console.log('PASS: migration plans for empty, legacy and partially migrated D1; account/profile preservation; second-run no-op; incompatible schema rejected');
