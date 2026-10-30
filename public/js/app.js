'use strict';

const STORAGE_KEY = 'beri_session_v1';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  familyId: null,
  memberId: null,
  role: null,
  code: null,
  displayName: null,
  data: null,
  ws: null,
  selectedKind: 'phone',
  selectedMins: null,
  historyFilter: 'all',
  countdownTimer: null,
  warnedLocal: new Set(),
  notifGranted: false,
};

function fmt(n) {
  const num = Number(n) || 0;
  return Math.abs(num).toLocaleString('vi-VN');
}

function amtHTML(n, forceSign = false) {
  const pos = n >= 0;
  const sign = forceSign || n < 0 || n > 0 ? (pos ? '+' : '−') : '';
  return `<span class="amt ${pos ? 'pos' : 'neg'}"><span class="coin-inline"></span> ${sign}${fmt(n)}</span>`;
}

function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    familyId: state.familyId,
    memberId: state.memberId,
    role: state.role,
    code: state.code,
    displayName: state.displayName,
  }));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch { return null; }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function showView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = $(`#view-${name}`);
  if (el) el.classList.add('active');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; t.classList.remove('show'); }, 2800);
}

async function api(path, body) {
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Lỗi mạng' }));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || 'Lỗi');
    err.data = data;
    throw err;
  }
  return data;
}

function connectWS() {
  if (!state.familyId) return;
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', familyId: state.familyId }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state' && msg.state) {
      applyState(msg.state);
    }
    if (msg.type === 'notify' || msg.notify) {
      const n = msg.notify || msg;
      maybeNotify(n);
    }
    if (msg.type === 'session_warn') {
      playAlarm();
      maybeNotify(msg.notify || { audience: 'all', title: 'Còn 5 phút', body: 'Sắp hết giờ' });
      const ban = $('#session-banner');
      if (ban) ban.classList.add('warn');
    }
    if (msg.type === 'session_end') {
      playAlarm();
      maybeNotify(msg.notify || { audience: 'all', title: 'Hết giờ', body: 'Hết giờ, tắt tivi/máy nhé' });
      const ban = $('#session-banner');
      if (ban) {
        ban.classList.remove('warn');
        ban.classList.add('end');
        $('#session-countdown').textContent = '00:00';
        $('#session-sub').textContent = 'Hết giờ, tắt tivi/máy nhé';
        setTimeout(() => { ban.hidden = true; ban.classList.remove('end'); }, 8000);
      }
    }
    if (msg.type === 'session_start' && msg.notify) {
      maybeNotify(msg.notify);
    }
  };
  ws.onclose = () => {
    setTimeout(connectWS, 2000);
  };
}

function maybeNotify(n) {
  if (!n) return;
  const aud = n.audience || 'all';
  if (aud !== 'all' && aud !== state.role) return;
  toast(`${n.title}: ${n.body || ''}`);
  if (state.notifGranted && Notification.permission === 'granted') {
    try {
      new Notification(n.title || 'Việc Nhà Của Bé', {
        body: n.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'beri-' + (n.title || 'n'),
      });
    } catch {}
  }
}

function playAlarm() {
  const audio = $('#alarm-audio');
  if (!audio) return;
  try {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {}
}

function applyState(s) {
  if (!s || !s.family) return;
  state.data = s;
  renderAll();
}

function myBalance() {
  const f = state.data?.family;
  if (!f) return 0;
  return state.role === 'parent' ? f.parent_balance : f.child_balance;
}

function otherBalance() {
  const f = state.data?.family;
  if (!f) return 0;
  return state.role === 'parent' ? f.child_balance : f.parent_balance;
}

function renderAll() {
  const d = state.data;
  if (!d) return;
  const isParent = state.role === 'parent';
  $('#role-pill').textContent = isParent ? 'Phụ huynh' : 'Con';
  const me = d.members.find(m => m.id === state.memberId);
  state.displayName = me?.display_name || state.displayName;
  $('#who-name').textContent = state.displayName || '—';
  $('#family-code').textContent = d.family.code;
  $('#more-code').textContent = d.family.code;
  state.code = d.family.code;

  $('#balance-num').textContent = fmt(myBalance());
  $('#wallet-label').textContent = isParent ? 'Ví phụ huynh' : 'Ví của con';
  const streak = d.family.streak_days || 0;
  $('#wallet-meta').textContent = isParent
    ? `Ví con: ${fmt(d.family.child_balance)} · Chuỗi làm việc: ${streak} ngày`
    : `Chuỗi làm việc: ${streak} ngày · Giới hạn giờ: ${d.family.daily_max_minutes} phút/ngày`;

  $('#btn-edit-rewards').hidden = !isParent;
  $('#penalties-card').hidden = !isParent;
  $('#btn-buy-time').hidden = isParent;
  $('#daily-max-card').hidden = !isParent;
  $('#daily-max-hint').textContent = `Giới hạn ngày: ${d.family.daily_max_minutes} phút (đã dùng xem lịch sử mua giờ)`;
  $('#daily-max-input').value = d.family.daily_max_minutes;
  $('#rename-input').value = state.displayName || '';

  renderPending();
  renderRewards();
  renderPenalties();
  renderHistory($('#home-history'), d.history.slice(0, 8));
  renderHistory($('#full-history'), d.history, state.historyFilter);
  renderMembers();
  renderSession();
}

function renderPending() {
  const box = $('#pending-box');
  const list = $('#pending-list');
  const pending = state.data.pending || [];
  if (!pending.length) { box.hidden = true; return; }
  box.hidden = false;
  const isParent = state.role === 'parent';
  list.innerHTML = pending.map(p => `
    <div class="item">
      <div>
        <div class="title">${escapeHtml(p.title)}</div>
        <div class="meta">${new Date(p.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' })}</div>
      </div>
      <div class="item-actions">
        ${amtHTML(p.amount, true)}
        ${isParent ? `
          <button class="btn primary sm" data-approve="${p.id}">Duyệt</button>
          <button class="btn danger outline sm" data-reject="${p.id}">Từ chối</button>
        ` : `<span class="hint">Chờ mẹ/bố duyệt</span>`}
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-approve]').forEach(btn => {
    btn.onclick = () => resolveTask(btn.dataset.approve, true);
  });
  list.querySelectorAll('[data-reject]').forEach(btn => {
    btn.onclick = () => resolveTask(btn.dataset.reject, false);
  });
}

async function resolveTask(pendingId, approve) {
  try {
    const r = await api('/task/resolve', {
      familyId: state.familyId, memberId: state.memberId, pendingId, approve
    });
    applyState(r.state);
    toast(approve ? 'Đã duyệt thưởng!' : 'Đã từ chối');
  } catch (e) { toast(e.message); }
}

function renderRewards() {
  const list = $('#rewards-list');
  const rewards = state.data.rewards || [];
  const isChild = state.role === 'child';
  list.innerHTML = rewards.map(r => `
    <div class="item">
      <div class="title">${escapeHtml(r.title)}</div>
      <div class="item-actions">
        ${amtHTML(r.amount, true)}
        ${isChild ? `<button class="btn secondary sm" data-claim="${r.id}">Xong việc</button>` : ''}
      </div>
    </div>
  `).join('') || '<p class="hint">Chưa có việc nào</p>';
  list.querySelectorAll('[data-claim]').forEach(btn => {
    btn.onclick = async () => {
      try {
        btn.disabled = true;
        const r = await api('/task/claim', {
          familyId: state.familyId, memberId: state.memberId, rewardId: btn.dataset.claim
        });
        applyState(r.state);
        toast('Đã gửi! Chờ phụ huynh duyệt');
      } catch (e) { toast(e.message); }
      finally { btn.disabled = false; }
    };
  });
}

function renderPenalties() {
  if (state.role !== 'parent') return;
  const list = $('#penalties-list');
  const penalties = state.data.penalties || [];
  list.innerHTML = penalties.map(p => `
    <div class="item">
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="item-actions">
        ${amtHTML(p.amount)}
        <button class="btn danger sm" data-penalty="${p.id}">Phạt</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-penalty]').forEach(btn => {
    btn.onclick = async () => {
      const note = $('#penalty-note').value.trim();
      try {
        const r = await api('/penalty/apply', {
          familyId: state.familyId, memberId: state.memberId,
          penaltyId: btn.dataset.penalty, note
        });
        applyState(r.state);
        toast('Đã trừ tiền');
      } catch (e) { toast(e.message); }
    };
  });
}

function renderHistory(el, items, filter = 'all') {
  if (!el) return;
  let rows = items || [];
  if (filter && filter !== 'all') rows = rows.filter(h => h.type === filter);
  if (!rows.length) {
    el.innerHTML = '<p class="hint">Chưa có giao dịch</p>';
    return;
  }
  const typeLabel = {
    earn: 'Thưởng', penalty: 'Phạt', transfer: 'Chuyển', purchase: 'Mua giờ', bonus: 'Thưởng tuần'
  };
  el.innerHTML = rows.map(h => `
    <div class="item">
      <div>
        <div class="title">${escapeHtml(h.title)}</div>
        <div class="meta">${typeLabel[h.type] || h.type} · ${new Date(h.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' })}${h.note ? ' · ' + escapeHtml(h.note) : ''}</div>
      </div>
      ${amtHTML(h.amount)}
    </div>
  `).join('');
}

function renderMembers() {
  const list = $('#members-list');
  const members = state.data.members || [];
  list.innerHTML = members.map(m => `
    <div class="item">
      <div class="title">${escapeHtml(m.display_name)}</div>
      <div class="meta">${m.role === 'parent' ? 'Phụ huynh' : 'Con'}${m.id === state.memberId ? ' · Bạn' : ''}</div>
    </div>
  `).join('');
}

function renderSession() {
  const sessions = (state.data.sessions || []).filter(s => !s.ended);
  const ban = $('#session-banner');
  if (!sessions.length) {
    ban.hidden = true;
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
    return;
  }
  const s = sessions[0];
  ban.hidden = false;
  ban.classList.remove('end');
  const label = s.kind === 'phone' ? 'Điện thoại / iPad' : 'Tivi';
  $('#session-title').textContent = `Đang dùng: ${label}`;
  const tick = () => {
    const left = Math.max(0, new Date(s.ends_at).getTime() - Date.now());
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    $('#session-countdown').textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    $('#session-sub').textContent = `Hết lúc ${new Date(s.ends_at).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Saigon', hour: '2-digit', minute: '2-digit' })}`;
    if (left <= 5 * 60 * 1000 && left > 0) ban.classList.add('warn');
    else ban.classList.remove('warn');
    // client-side best-effort alarm if WS missed
    if (left <= 5 * 60 * 1000 && left > 4.5 * 60 * 1000 && !state.warnedLocal.has(s.id + '-5')) {
      state.warnedLocal.add(s.id + '-5');
      playAlarm();
      maybeNotify({ audience: 'all', title: 'Còn 5 phút', body: `Sắp hết giờ, chuẩn bị tắt ${s.kind === 'phone' ? 'máy' : 'tivi'} nhé` });
    }
    if (left <= 0 && !state.warnedLocal.has(s.id + '-0')) {
      state.warnedLocal.add(s.id + '-0');
      playAlarm();
      maybeNotify({ audience: 'all', title: 'Hết giờ', body: `Hết giờ, tắt ${s.kind === 'phone' ? 'máy' : 'tivi'} nhé` });
    }
  };
  tick();
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(tick, 1000);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ——— Onboarding ———
$('#btn-goto-create').onclick = () => showView('create');
$('#btn-goto-join').onclick = () => showView('join');
$$('[data-back]').forEach(b => b.onclick = () => showView(b.dataset.back));

$('#btn-create').onclick = async () => {
  const err = $('#create-error');
  err.hidden = true;
  try {
    const r = await api('/family/create', {
      parentName: $('#create-parent-name').value.trim() || 'Phụ huynh',
      familyName: $('#create-family-name').value.trim() || 'Gia đình mình',
    });
    state.familyId = r.familyId;
    state.memberId = r.memberId;
    state.role = 'parent';
    state.code = r.code;
    state.displayName = $('#create-parent-name').value.trim() || 'Phụ huynh';
    saveSession();
    applyState(r.state);
    connectWS();
    showView('home');
    toast('Mã gia đình: ' + r.code + ' — đưa mã này cho con');
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
};

$('#btn-join').onclick = async () => {
  const err = $('#join-error');
  err.hidden = true;
  try {
    const r = await api('/family/join', {
      code: $('#join-code').value.trim(),
      childName: $('#join-child-name').value.trim() || 'Con',
    });
    state.familyId = r.familyId;
    state.memberId = r.memberId;
    state.role = 'child';
    state.code = r.code;
    state.displayName = $('#join-child-name').value.trim() || 'Con';
    saveSession();
    applyState(r.state);
    connectWS();
    showView('home');
    toast('Đã vào gia đình!');
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
};

// Tabs
$$('.tab').forEach(tab => {
  tab.onclick = () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#${tab.dataset.tab}`).classList.add('active');
  };
});

// Transfer
$('#btn-transfer').onclick = async () => {
  const msg = $('#transfer-msg');
  try {
    const r = await api('/transfer', {
      familyId: state.familyId,
      memberId: state.memberId,
      direction: $('#transfer-dir').value,
      amount: $('#transfer-amount').value,
    });
    applyState(r.state);
    $('#transfer-amount').value = '';
    msg.hidden = true;
    toast('Đã chuyển!');
  } catch (e) {
    msg.textContent = e.message;
    msg.hidden = false;
  }
};

// Custom penalty
$('#btn-custom-penalty').onclick = async () => {
  try {
    const r = await api('/penalty/apply', {
      familyId: state.familyId,
      memberId: state.memberId,
      penaltyId: 'custom',
      customTitle: $('#custom-penalty-title').value.trim() || 'Phạt nặng',
      customAmount: $('#custom-penalty-amount').value,
      note: $('#penalty-note').value.trim(),
    });
    applyState(r.state);
    $('#custom-penalty-title').value = '';
    $('#custom-penalty-amount').value = '';
    toast('Đã phạt nặng');
  } catch (e) { toast(e.message); }
};

// Time buy
$$('.kind-pick .chip').forEach(c => {
  c.onclick = () => {
    $$('.kind-pick .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    state.selectedKind = c.dataset.kind;
  };
});
$$('.mins-pick .chip').forEach(c => {
  c.onclick = () => {
    $$('.mins-pick .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    state.selectedMins = parseInt(c.dataset.mins, 10);
  };
});
$('#btn-buy-time').onclick = async () => {
  if (!state.selectedMins) { toast('Chọn số phút'); return; }
  try {
    const r = await api('/time/buy', {
      familyId: state.familyId,
      memberId: state.memberId,
      kind: state.selectedKind,
      minutes: state.selectedMins,
    });
    applyState(r.state);
    toast('Đã bắt đầu giờ chơi!');
    enableNotif();
  } catch (e) {
    $('#time-msg').textContent = e.message;
    $('#time-msg').hidden = false;
    toast(e.message);
  }
};

$('#btn-save-daily-max').onclick = async () => {
  try {
    const r = await api('/settings/daily-max', {
      familyId: state.familyId,
      memberId: state.memberId,
      minutes: $('#daily-max-input').value,
    });
    applyState(r.state);
    toast('Đã lưu giới hạn ngày');
  } catch (e) { toast(e.message); }
};

// History
$('#btn-open-history').onclick = () => {
  state.historyFilter = 'all';
  $$('.filters .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
  renderHistory($('#full-history'), state.data?.history || [], 'all');
  showView('history');
};
$('#btn-close-history').onclick = () => showView('home');
$$('.filters .chip').forEach(c => {
  c.onclick = () => {
    $$('.filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    state.historyFilter = c.dataset.filter;
    renderHistory($('#full-history'), state.data?.history || [], state.historyFilter);
  };
});

// Edit rewards
$('#btn-edit-rewards').onclick = () => {
  const list = $('#edit-rewards-list');
  list.innerHTML = '';
  (state.data.rewards || []).forEach(r => addEditRow(r.title, r.amount, r.id));
  showView('edit-rewards');
};
$('#btn-close-edit-rewards').onclick = () => showView('home');
$('#btn-add-reward').onclick = () => addEditRow('', 5000, null);
function addEditRow(title, amount, id) {
  const row = document.createElement('div');
  row.className = 'edit-row';
  row.dataset.id = id || '';
  row.innerHTML = `
    <input type="text" class="er-title" placeholder="Tên việc" value="${escapeHtml(title)}" maxlength="80" />
    <input type="number" class="er-amt" value="${amount}" min="0" step="1000" />
    <button class="del" type="button" aria-label="Xoá">×</button>
  `;
  row.querySelector('.del').onclick = () => row.remove();
  $('#edit-rewards-list').appendChild(row);
}
$('#btn-save-rewards').onclick = async () => {
  const rewards = $$('#edit-rewards-list .edit-row').map(row => ({
    id: row.dataset.id || undefined,
    title: row.querySelector('.er-title').value.trim(),
    amount: parseInt(row.querySelector('.er-amt').value, 10) || 0,
  })).filter(r => r.title);
  try {
    const r = await api('/rewards/save', {
      familyId: state.familyId, memberId: state.memberId, rewards
    });
    applyState(r.state);
    showView('home');
    toast('Đã lưu danh sách thưởng');
  } catch (e) { toast(e.message); }
};

$('#btn-rename').onclick = async () => {
  try {
    const r = await api('/member/rename', {
      familyId: state.familyId, memberId: state.memberId,
      displayName: $('#rename-input').value.trim(),
    });
    applyState(r.state);
    saveSession();
    toast('Đã đổi tên');
  } catch (e) { toast(e.message); }
};

$('#btn-copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.code || '');
    toast('Đã sao chép mã ' + state.code);
  } catch {
    toast('Mã: ' + state.code);
  }
};

$('#btn-logout').onclick = () => {
  if (!confirm('Đăng xuất thiết bị này? (Gia đình trên máy khác vẫn giữ nguyên)')) return;
  clearSession();
  if (state.ws) try { state.ws.close(); } catch {}
  location.reload();
};

async function enableNotif() {
  try {
    if (!('Notification' in window)) { toast('Máy này không hỗ trợ thông báo'); return; }
    const perm = await Notification.requestPermission();
    state.notifGranted = perm === 'granted';
    if (state.notifGranted) {
      toast('Đã bật thông báo');
      // unlock audio
      playAlarm();
    } else {
      toast('Chưa cho phép thông báo');
    }
  } catch (e) { toast('Không bật được thông báo'); }
}
$('#btn-enable-notif').onclick = enableNotif;

// Generate alarm tone via Web Audio into audio element (data URI wav)
function buildAlarmDataUri() {
  // short beep-beep pattern as WAV
  const sampleRate = 22050;
  const duration = 1.2;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let amp = 0;
    // two beeps
    if ((t > 0.05 && t < 0.35) || (t > 0.5 && t < 0.8)) {
      amp = Math.sin(2 * Math.PI * 880 * t) * 0.55;
    }
    view.setInt16(44 + i * 2, amp * 32767, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

function initAlarm() {
  const audio = $('#alarm-audio');
  audio.src = buildAlarmDataUri();
}

async function boot() {
  initAlarm();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }
  const saved = loadSession();
  if (saved?.familyId && saved?.memberId) {
    state.familyId = saved.familyId;
    state.memberId = saved.memberId;
    state.role = saved.role;
    state.code = saved.code;
    state.displayName = saved.displayName;
    try {
      const r = await api(`/family/${state.familyId}/state`);
      // verify member still exists
      const me = r.state.members.find(m => m.id === state.memberId);
      if (!me) throw new Error('Phiên cũ');
      state.role = me.role;
      applyState(r.state);
      connectWS();
      showView('home');
      const tab = new URLSearchParams(location.search).get('tab');
      if (tab) {
        const btn = document.querySelector(`.tab[data-tab="tab-${tab}"]`);
        if (btn) btn.click();
        history.replaceState({}, '', '/');
      }
      return;
    } catch {
      clearSession();
    }
  }
  showView('welcome');
}

boot();
