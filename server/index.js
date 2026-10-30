'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { db, DEFAULT_REWARDS, DEFAULT_PENALTIES } = require('./db');

const PORT = process.env.PORT || 3847;
const RATE_PER_HOUR = 25000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Set<import('ws')>>} */
const familySockets = new Map();

function nowISO() {
  return new Date().toISOString();
}

function todayVN() {
  // Asia/Saigon calendar date
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Saigon',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  const exists = db.prepare('SELECT 1 FROM families WHERE code = ?').get(code);
  return exists ? genCode() : code;
}

function getFamily(id) {
  return db.prepare('SELECT * FROM families WHERE id = ?').get(id);
}

function getFamilyByCode(code) {
  return db.prepare('SELECT * FROM families WHERE code = ?').get(String(code || '').toUpperCase().trim());
}

function familyState(familyId) {
  const family = getFamily(familyId);
  if (!family) return null;
  const members = db.prepare('SELECT id, role, display_name, created_at FROM members WHERE family_id = ?').all(familyId);
  const rewards = db.prepare('SELECT * FROM rewards WHERE family_id = ? AND active = 1 ORDER BY sort_order, title').all(familyId);
  const penalties = db.prepare('SELECT * FROM penalties WHERE family_id = ? AND active = 1 ORDER BY sort_order, title').all(familyId);
  const pending = db.prepare(`SELECT * FROM pending_tasks WHERE family_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(familyId);
  const history = db.prepare('SELECT * FROM history WHERE family_id = ? ORDER BY created_at DESC LIMIT 200').all(familyId);
  const sessions = db.prepare(`SELECT * FROM sessions WHERE family_id = ? AND ended = 0 ORDER BY ends_at ASC`).all(familyId);
  return { family, members, rewards, penalties, pending, history, sessions, serverTime: nowISO() };
}

function addHistory(familyId, type, title, amount, note, actorRole) {
  const fam = getFamily(familyId);
  db.prepare(`INSERT INTO history (id, family_id, type, title, amount, note, actor_role, balance_after_parent, balance_after_child, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uuidv4(), familyId, type, title, amount, note || null, actorRole || null,
    fam.parent_balance, fam.child_balance, nowISO()
  );
}

function broadcast(familyId, payload) {
  const set = familySockets.get(familyId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function pushState(familyId, event) {
  const state = familyState(familyId);
  broadcast(familyId, { type: 'state', event: event || 'update', state });
  return state;
}

function seedDefaults(familyId) {
  const insR = db.prepare('INSERT INTO rewards (id, family_id, title, amount, sort_order) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_REWARDS.forEach(([title, amount], i) => insR.run(uuidv4(), familyId, title, amount, i));
  const insP = db.prepare('INSERT INTO penalties (id, family_id, title, amount, sort_order) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_PENALTIES.forEach(([title, amount], i) => insP.run(uuidv4(), familyId, title, amount, i));
}

function updateStreakOnApprove(familyId) {
  const fam = getFamily(familyId);
  const today = todayVN();
  const last = fam.last_task_date;
  let streak = fam.streak_days || 0;
  if (last === today) {
    // already counted today
  } else {
    const yest = (() => {
      const d = new Date(today + 'T12:00:00+07:00');
      d.setDate(d.getDate() - 1);
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(d);
    })();
    streak = last === yest ? streak + 1 : 1;
    db.prepare('UPDATE families SET streak_days = ?, last_task_date = ? WHERE id = ?')
      .run(streak, today, familyId);
    if (streak > 0 && streak % 7 === 0) {
      // weekly bonus 15000 to child from parent wallet
      const amount = 15000;
      const f = getFamily(familyId);
      if (f.parent_balance >= amount) {
        db.prepare('UPDATE families SET parent_balance = parent_balance - ?, child_balance = child_balance + ? WHERE id = ?')
          .run(amount, amount, familyId);
        addHistory(familyId, 'bonus', 'Thưởng tuần (7 ngày liên tục)', amount, `Chuỗi ${streak} ngày`, 'system');
      }
    }
  }
}

// ——— API ———

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: nowISO() });
});

app.post('/api/family/create', (req, res) => {
  try {
    const { parentName, familyName } = req.body || {};
    const name = (familyName || 'Gia đình mình').trim().slice(0, 40) || 'Gia đình mình';
    const display = (parentName || 'Phụ huynh').trim().slice(0, 40) || 'Phụ huynh';
    const familyId = uuidv4();
    const memberId = uuidv4();
    const code = genCode();
    const created = nowISO();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO families (id, code, name, parent_balance, child_balance, created_at)
        VALUES (?, ?, ?, 1000000000, 0, ?)`).run(familyId, code, name, created);
      db.prepare(`INSERT INTO members (id, family_id, role, display_name, created_at)
        VALUES (?, ?, 'parent', ?, ?)`).run(memberId, familyId, display, created);
      seedDefaults(familyId);
    });
    tx();
    const state = familyState(familyId);
    res.json({ ok: true, familyId, memberId, role: 'parent', code, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Không tạo được gia đình' });
  }
});

app.post('/api/family/join', (req, res) => {
  try {
    const { code, childName } = req.body || {};
    const fam = getFamilyByCode(code);
    if (!fam) return res.status(404).json({ ok: false, error: 'Mã gia đình không đúng' });
    const childCount = db.prepare(`SELECT COUNT(*) AS c FROM members WHERE family_id = ? AND role = 'child'`).get(fam.id).c;
    if (childCount >= 5) return res.status(400).json({ ok: false, error: 'Gia đình đã đủ thành viên con' });
    const memberId = uuidv4();
    const display = (childName || 'Con').trim().slice(0, 40) || 'Con';
    db.prepare(`INSERT INTO members (id, family_id, role, display_name, created_at)
      VALUES (?, ?, 'child', ?, ?)`).run(memberId, fam.id, display, nowISO());
    const state = pushState(fam.id, 'member_joined');
    res.json({ ok: true, familyId: fam.id, memberId, role: 'child', code: fam.code, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Không tham gia được' });
  }
});

app.get('/api/family/:id/state', (req, res) => {
  const state = familyState(req.params.id);
  if (!state) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
  res.json({ ok: true, state });
});

app.post('/api/task/claim', (req, res) => {
  try {
    const { familyId, memberId, rewardId } = req.body || {};
    const fam = getFamily(familyId);
    if (!fam) return res.status(404).json({ ok: false, error: 'Không tìm thấy gia đình' });
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member || member.role !== 'child') return res.status(403).json({ ok: false, error: 'Chỉ con mới báo xong việc' });
    const reward = db.prepare('SELECT * FROM rewards WHERE id = ? AND family_id = ? AND active = 1').get(rewardId, familyId);
    if (!reward) return res.status(404).json({ ok: false, error: 'Không tìm thấy việc' });
    const id = uuidv4();
    db.prepare(`INSERT INTO pending_tasks (id, family_id, reward_id, title, amount, child_member_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, familyId, rewardId, reward.title, reward.amount, memberId, nowISO());
    const state = pushState(familyId, 'task_claimed');
    broadcast(familyId, { type: 'notify', audience: 'parent', title: 'Con báo xong việc', body: `${reward.title} (+${reward.amount.toLocaleString('vi-VN')})` });
    res.json({ ok: true, pendingId: id, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/task/resolve', (req, res) => {
  try {
    const { familyId, memberId, pendingId, approve } = req.body || {};
    const fam = getFamily(familyId);
    if (!fam) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member || member.role !== 'parent') return res.status(403).json({ ok: false, error: 'Chỉ phụ huynh duyệt' });
    const task = db.prepare(`SELECT * FROM pending_tasks WHERE id = ? AND family_id = ? AND status = 'pending'`).get(pendingId, familyId);
    if (!task) return res.status(404).json({ ok: false, error: 'Không còn chờ duyệt' });
    if (approve) {
      if (fam.parent_balance < task.amount) {
        return res.status(400).json({ ok: false, error: 'Ví phụ huynh không đủ' });
      }
      const tx = db.transaction(() => {
        db.prepare(`UPDATE pending_tasks SET status = 'approved', resolved_at = ? WHERE id = ?`).run(nowISO(), pendingId);
        db.prepare('UPDATE families SET parent_balance = parent_balance - ?, child_balance = child_balance + ? WHERE id = ?')
          .run(task.amount, task.amount, familyId);
        addHistory(familyId, 'earn', task.title, task.amount, 'Phụ huynh duyệt', 'parent');
        updateStreakOnApprove(familyId);
      });
      tx();
      broadcast(familyId, { type: 'notify', audience: 'child', title: 'Được thưởng!', body: `${task.title} +${task.amount.toLocaleString('vi-VN')}` });
    } else {
      db.prepare(`UPDATE pending_tasks SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(nowISO(), pendingId);
      broadcast(familyId, { type: 'notify', audience: 'child', title: 'Chưa được duyệt', body: task.title });
    }
    const state = pushState(familyId, approve ? 'task_approved' : 'task_rejected');
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/penalty/apply', (req, res) => {
  try {
    const { familyId, memberId, penaltyId, customAmount, customTitle, note } = req.body || {};
    const fam = getFamily(familyId);
    if (!fam) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member || member.role !== 'parent') return res.status(403).json({ ok: false, error: 'Chỉ phụ huynh phạt' });

    let title, amount;
    if (penaltyId === 'custom' || customAmount) {
      title = (customTitle || 'Phạt nặng').trim().slice(0, 60) || 'Phạt nặng';
      amount = -Math.abs(parseInt(customAmount, 10) || 0);
      if (!amount) return res.status(400).json({ ok: false, error: 'Nhập số tiền phạt' });
    } else {
      const p = db.prepare('SELECT * FROM penalties WHERE id = ? AND family_id = ? AND active = 1').get(penaltyId, familyId);
      if (!p) return res.status(404).json({ ok: false, error: 'Không tìm thấy mức phạt' });
      title = p.title;
      amount = p.amount; // already negative
    }
    // deduct from child; never wipe to zero beyond balance (clamp)
    const deduct = Math.min(Math.abs(amount), fam.child_balance);
    const applied = -deduct;
    db.prepare('UPDATE families SET child_balance = child_balance + ? WHERE id = ?').run(applied, familyId);
    addHistory(familyId, 'penalty', title, applied, note || null, 'parent');
    broadcast(familyId, { type: 'notify', audience: 'child', title: 'Bị phạt', body: `${title} ${applied.toLocaleString('vi-VN')}` });
    const state = pushState(familyId, 'penalty');
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/transfer', (req, res) => {
  try {
    const { familyId, memberId, direction, amount, note } = req.body || {};
    const fam = getFamily(familyId);
    if (!fam) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member) return res.status(403).json({ ok: false, error: 'Không hợp lệ' });
    const amt = Math.abs(parseInt(amount, 10) || 0);
    if (!amt) return res.status(400).json({ ok: false, error: 'Nhập số tiền' });
    // direction: parent_to_child | child_to_parent
    // either role can initiate either way (per user request)
    if (direction === 'parent_to_child') {
      if (fam.parent_balance < amt) return res.status(400).json({ ok: false, error: 'Ví phụ huynh không đủ' });
      db.prepare('UPDATE families SET parent_balance = parent_balance - ?, child_balance = child_balance + ? WHERE id = ?')
        .run(amt, amt, familyId);
      addHistory(familyId, 'transfer', 'Chuyển cho con', amt, note || null, member.role);
    } else if (direction === 'child_to_parent') {
      if (fam.child_balance < amt) return res.status(400).json({ ok: false, error: 'Ví con không đủ' });
      db.prepare('UPDATE families SET child_balance = child_balance - ?, parent_balance = parent_balance + ? WHERE id = ?')
        .run(amt, amt, familyId);
      addHistory(familyId, 'transfer', 'Con chuyển cho phụ huynh', amt, note || null, member.role);
    } else {
      return res.status(400).json({ ok: false, error: 'Hướng chuyển không hợp lệ' });
    }
    broadcast(familyId, { type: 'notify', audience: 'all', title: 'Chuyển tiền', body: `${amt.toLocaleString('vi-VN')}` });
    const state = pushState(familyId, 'transfer');
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/time/buy', (req, res) => {
  try {
    const { familyId, memberId, kind, minutes } = req.body || {};
    const fam = getFamily(familyId);
    if (!fam) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member || member.role !== 'child') return res.status(403).json({ ok: false, error: 'Chỉ con mua thời gian' });
    if (!['phone', 'tv'].includes(kind)) return res.status(400).json({ ok: false, error: 'Loại không hợp lệ' });
    const mins = parseInt(minutes, 10);
    if (![15, 30, 60].includes(mins)) return res.status(400).json({ ok: false, error: 'Chọn 15 / 30 / 60 phút' });

    // daily usage check
    const todayStart = todayVN() + 'T00:00:00.000+07:00';
    const used = db.prepare(`SELECT COALESCE(SUM(minutes),0) AS m FROM sessions WHERE family_id = ? AND started_at >= ?`)
      .get(familyId, new Date(todayStart).toISOString()).m;
    if (used + mins > fam.daily_max_minutes) {
      return res.status(400).json({
        ok: false,
        error: `Vượt giới hạn ngày (${fam.daily_max_minutes} phút). Đã dùng ${used} phút.`
      });
    }

    const cost = Math.round(RATE_PER_HOUR * (mins / 60));
    if (fam.child_balance < cost) return res.status(400).json({ ok: false, error: 'Không đủ tiền' });

    const id = uuidv4();
    const start = new Date();
    const end = new Date(start.getTime() + mins * 60 * 1000);
    const label = kind === 'phone' ? 'Điện thoại/iPad' : 'Tivi';
    const tx = db.transaction(() => {
      db.prepare('UPDATE families SET child_balance = child_balance - ? WHERE id = ?').run(cost, familyId);
      db.prepare(`INSERT INTO sessions (id, family_id, kind, minutes, cost, started_at, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, familyId, kind, mins, cost, start.toISOString(), end.toISOString());
      addHistory(familyId, 'purchase', `Mua giờ ${label}`, -cost, `${mins} phút`, 'child');
    });
    tx();
    broadcast(familyId, {
      type: 'session_start',
      session: { id, kind, minutes: mins, cost, started_at: start.toISOString(), ends_at: end.toISOString() },
      notify: { audience: 'all', title: 'Bắt đầu giờ dùng', body: `${label} · ${mins} phút` }
    });
    const state = pushState(familyId, 'session_start');
    res.json({ ok: true, sessionId: id, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/settings/daily-max', (req, res) => {
  try {
    const { familyId, memberId, minutes } = req.body || {};
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member || member.role !== 'parent') return res.status(403).json({ ok: false, error: 'Chỉ phụ huynh' });
    const m = Math.max(15, Math.min(480, parseInt(minutes, 10) || 120));
    db.prepare('UPDATE families SET daily_max_minutes = ? WHERE id = ?').run(m, familyId);
    const state = pushState(familyId, 'settings');
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/rewards/save', (req, res) => {
  try {
    const { familyId, memberId, rewards } = req.body || {};
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member || member.role !== 'parent') return res.status(403).json({ ok: false, error: 'Chỉ phụ huynh' });
    if (!Array.isArray(rewards)) return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ' });
    const tx = db.transaction(() => {
      db.prepare('UPDATE rewards SET active = 0 WHERE family_id = ?').run(familyId);
      const ins = db.prepare('INSERT INTO rewards (id, family_id, title, amount, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)');
      const upd = db.prepare('UPDATE rewards SET title = ?, amount = ?, sort_order = ?, active = 1 WHERE id = ? AND family_id = ?');
      rewards.forEach((r, i) => {
        const title = String(r.title || '').trim().slice(0, 80);
        const amount = Math.max(0, parseInt(r.amount, 10) || 0);
        if (!title) return;
        if (r.id) {
          const exists = db.prepare('SELECT id FROM rewards WHERE id = ? AND family_id = ?').get(r.id, familyId);
          if (exists) upd.run(title, amount, i, r.id, familyId);
          else ins.run(r.id, familyId, title, amount, i);
        } else {
          ins.run(uuidv4(), familyId, title, amount, i);
        }
      });
    });
    tx();
    const state = pushState(familyId, 'rewards_updated');
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

app.post('/api/member/rename', (req, res) => {
  try {
    const { familyId, memberId, displayName } = req.body || {};
    const member = db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(memberId, familyId);
    if (!member) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
    const name = String(displayName || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ ok: false, error: 'Nhập tên' });
    db.prepare('UPDATE members SET display_name = ? WHERE id = ?').run(name, memberId);
    const state = pushState(familyId, 'rename');
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Lỗi' });
  }
});

// Session timer tick — warn at 5 min, end at 0
setInterval(() => {
  const active = db.prepare(`SELECT * FROM sessions WHERE ended = 0`).all();
  const now = Date.now();
  for (const s of active) {
    const ends = new Date(s.ends_at).getTime();
    const left = ends - now;
    if (!s.warned_5 && left <= 5 * 60 * 1000 && left > 0) {
      db.prepare('UPDATE sessions SET warned_5 = 1 WHERE id = ?').run(s.id);
      const label = s.kind === 'phone' ? 'máy' : 'tivi';
      broadcast(s.family_id, {
        type: 'session_warn',
        sessionId: s.id,
        minutesLeft: 5,
        notify: { audience: 'all', title: 'Còn 5 phút', body: `Sắp hết giờ, chuẩn bị tắt ${label} nhé` }
      });
    }
    if (left <= 0) {
      db.prepare('UPDATE sessions SET ended = 1 WHERE id = ?').run(s.id);
      const label = s.kind === 'phone' ? 'máy' : 'tivi';
      broadcast(s.family_id, {
        type: 'session_end',
        sessionId: s.id,
        notify: { audience: 'all', title: 'Hết giờ', body: `Hết giờ, tắt ${label} nhé` }
      });
      pushState(s.family_id, 'session_end');
    }
  }
}, 5000);

// WebSocket
wss.on('connection', (ws, req) => {
  let familyId = null;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'subscribe' && msg.familyId) {
        familyId = msg.familyId;
        if (!familySockets.has(familyId)) familySockets.set(familyId, new Set());
        familySockets.get(familyId).add(ws);
        const state = familyState(familyId);
        ws.send(JSON.stringify({ type: 'state', event: 'subscribe', state }));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: nowISO() }));
      }
    } catch (_) { /* ignore */ }
  });
  ws.on('close', () => {
    if (familyId && familySockets.has(familyId)) {
      familySockets.get(familyId).delete(ws);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Beri app listening on http://0.0.0.0:${PORT}`);
});
