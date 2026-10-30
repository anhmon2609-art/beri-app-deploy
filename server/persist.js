'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { Pool } = require('pg');

function githubRequest(method, apiPath, token, body) {
  const payload = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: 'api.github.com',
    path: apiPath,
    method,
    headers: {
      'User-Agent': 'viec-nha-cua-be-persist',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (payload) {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, data });
        else reject(new Error(`GitHub ${res.statusCode}: ${(data && data.message) || raw.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setupGithubPersist(dbFilePath) {
  const token = process.env.GITHUB_PERSIST_TOKEN;
  const repo = process.env.GITHUB_PERSIST_REPO; // owner/name
  const filePath = process.env.GITHUB_PERSIST_PATH || 'data/export/beri.db.snapshot';
  if (!token || !repo) return null;

  const apiPath = `/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  console.log('[persist] GitHub backend', repo, filePath);

  // Restore
  try {
    const branch = process.env.GITHUB_PERSIST_BRANCH || 'main';
    const { data } = await githubRequest('GET', `${apiPath}?ref=${encodeURIComponent(branch)}`, token);
    if (data && data.content) {
      const buf = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
      fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
      for (const side of ['-wal', '-shm']) {
        const p = dbFilePath + side;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      fs.writeFileSync(dbFilePath, buf);
      console.log('[persist] Restored SQLite from GitHub,', buf.length, 'bytes, sha', data.sha);
      global.__beriGithubSha = data.sha;
    }
  } catch (err) {
    if (!/404/.test(err.message)) console.warn('[persist] GitHub restore:', err.message);
    else console.log('[persist] No GitHub snapshot yet');
  }

  let flushing = false;
  let lastHash = null;
  async function flush(reason) {
    if (flushing) return;
    flushing = true;
    try {
      if (!fs.existsSync(dbFilePath)) return;
      const buf = fs.readFileSync(dbFilePath);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (hash === lastHash && reason !== 'stop' && reason !== 'initial') {
        return; // unchanged
      }
      const content = buf.toString('base64');
      const branch = process.env.GITHUB_PERSIST_BRANCH || 'main';
      const getPath = `${apiPath}?ref=${encodeURIComponent(branch)}`;
      const body = {
        message: `persist sqlite (${reason}) ${new Date().toISOString()}`,
        content,
        branch,
      };
      if (global.__beriGithubSha) body.sha = global.__beriGithubSha;
      try {
        const { data } = await githubRequest('PUT', apiPath, token, body);
        global.__beriGithubSha = data.content && data.content.sha;
        lastHash = hash;
        console.log('[persist] Flushed to GitHub (', buf.length, 'bytes) —', reason);
      } catch (err) {
        if (/409|sha|conflict/i.test(err.message)) {
          const { data: cur } = await githubRequest('GET', getPath, token);
          body.sha = cur.sha;
          const { data } = await githubRequest('PUT', apiPath, token, body);
          global.__beriGithubSha = data.content && data.content.sha;
          lastHash = hash;
          console.log('[persist] Flushed to GitHub after conflict (', buf.length, 'bytes) —', reason);
        } else throw err;
      }
    } catch (err) {
      console.warn('[persist] GitHub flush failed:', err.message);
    } finally {
      flushing = false;
    }
  }

  return { flush, kind: 'github' };
}

async function setupPostgresPersist(dbFilePath) {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sqlite_snapshots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const existing = await pool.query('SELECT octet_length(data) AS n FROM sqlite_snapshots WHERE id = 1');
  if (existing.rows.length && existing.rows[0].n > 0) {
    const { rows } = await pool.query('SELECT data FROM sqlite_snapshots WHERE id = 1');
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
    for (const side of ['-wal', '-shm']) {
      const p = dbFilePath + side;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.writeFileSync(dbFilePath, rows[0].data);
    console.log('[persist] Restored SQLite from Postgres,', rows[0].data.length, 'bytes');
  } else {
    console.log('[persist] No Postgres snapshot yet');
  }

  let flushing = false;
  async function flush(reason) {
    if (flushing) return;
    flushing = true;
    try {
      if (!fs.existsSync(dbFilePath)) return;
      const buf = fs.readFileSync(dbFilePath);
      await pool.query(
        `INSERT INTO sqlite_snapshots (id, data, updated_at) VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [buf]
      );
      console.log('[persist] Flushed SQLite to Postgres (', buf.length, 'bytes) —', reason);
    } catch (err) {
      console.warn('[persist] Postgres flush failed:', err.message);
    } finally {
      flushing = false;
    }
  }

  process.on('SIGTERM', () => { flush('SIGTERM').finally(() => pool.end().finally(() => process.exit(0))); });
  return { flush, kind: 'postgres', pool };
}

async function setupSqlitePersist(dbFilePath) {
  // Prefer Postgres when configured; else GitHub private repo snapshot
  let backend = await setupPostgresPersist(dbFilePath);
  if (!backend) backend = await setupGithubPersist(dbFilePath);
  if (!backend) {
    console.log('[persist] No DATABASE_URL or GITHUB_PERSIST_TOKEN; SQLite ephemeral on free web');
    return { flush: async () => {}, stop: async () => {} };
  }

  // Initial upload if local exists (boot.js owns periodic checkpoint)
  if (fs.existsSync(dbFilePath) && fs.statSync(dbFilePath).size > 0) {
    await backend.flush('initial');
  }

  return {
    flush: backend.flush,
    stop: async () => {
      await backend.flush('stop');
      if (backend.pool) await backend.pool.end();
    },
  };
}

module.exports = { setupSqlitePersist };
