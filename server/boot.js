'use strict';
const path = require('path');
const fs = require('fs');
const { setupSqlitePersist } = require('./persist');

async function main() {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(dataDir, 'beri.db');
  process.env.DATABASE_PATH = dbPath;

  const persist = await setupSqlitePersist(dbPath);

  // Load app (opens SQLite after restore)
  require('./index');
  const { db } = require('./db');

  const intervalMs = Number(process.env.PERSIST_INTERVAL_MS || 120000);
  setInterval(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    persist.flush('checkpoint').catch(() => {});
  }, intervalMs).unref?.();

  // Flush after mutating API — light touch: also flush every WS broadcast is overkill
  console.log('[boot] Persist hooked; interval', intervalMs, 'ms');
}

main().catch((err) => {
  console.error('[boot] Fatal', err);
  process.exit(1);
});
