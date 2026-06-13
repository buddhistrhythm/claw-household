/* lifeos PWA — vanilla JS controller.
 * Routing via location.hash (#baby/#inbox/#search/#stats) so home-screen
 * install + back button work. Network = fetch with same-origin credentials.
 * 路由用 hash，便于 PWA 主屏安装与后退；fetch 同源。
 */
(function () {
  'use strict';

  // ── tab routing / Tab 路由 ─────────────────────────────────────────────
  const TABS = ['baby', 'inbox', 'search', 'stats'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'baby';
    for (const t of TABS) {
      const view = document.getElementById('view-' + t);
      if (view) view.hidden = t !== name;
    }
    document.querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === name);
    });
    if (name === 'inbox') loadInbox();
    if (name === 'stats') loadStats();
  }
  function tabFromHash() {
    return (location.hash || '#baby').slice(1);
  }
  window.addEventListener('hashchange', () => showTab(tabFromHash()));

  // ── HTTP helper / 统一请求 ─────────────────────────────────────────────
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
    let data = null;
    try { data = await r.json(); } catch { /* keep null */ }
    if (!r.ok) {
      const err = new Error((data && (data.error || data.detail)) || ('HTTP ' + r.status));
      err.status = r.status; err.data = data;
      throw err;
    }
    return data;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── Baby: 宝宝哭了 → /api/baby/cry ─────────────────────────────────────
  const cryBtn = document.getElementById('cry-btn');
  const cryResult = document.getElementById('cry-result');

  function renderCandidates(payload) {
    if (!payload || !Array.isArray(payload.candidates) || !payload.candidates.length) {
      cryResult.innerHTML = '<p class="muted">没有候选 — 检查近期记录或宝宝档案。</p>';
      return;
    }
    const html = payload.candidates.map((c) => {
      const pct = Math.round((Number(c.score) || 0) * 100);
      const signals = Array.isArray(c.signals) ? c.signals.map((s) => {
        const v = s.value != null ? esc(String(s.value)) + (s.unit ? esc(s.unit) : '') : '';
        const bm = s.benchmark != null ? ' / ' + esc(String(s.benchmark)) : '';
        return '<li><span>' + esc(s.text || s.kind || '') + '</span>'
             + (v || bm ? '<span class="muted"> ' + v + bm + '</span>' : '')
             + '</li>';
      }).join('') : '';
      return ''
        + '<article class="card" data-reason="' + esc(c.reason) + '">'
        +   '<div class="card-row">'
        +     '<div class="card-icon">' + esc(c.icon || '👶') + '</div>'
        +     '<div class="card-label">' + esc(c.label || c.reason) + '</div>'
        +     '<div class="card-pct">' + pct + '%</div>'
        +   '</div>'
        +   (c.reasoning ? '<p class="card-reason">' + esc(c.reasoning) + '</p>' : '')
        +   '<div class="bar"><i style="width:' + pct + '%"></i></div>'
        +   (signals ? '<details class="evidence"><summary>依据 / evidence</summary>'
                     + '<ul class="signals">' + signals + '</ul></details>' : '')
        + '</article>';
    }).join('');
    cryResult.innerHTML = html;
  }

  cryBtn.addEventListener('click', async () => {
    cryResult.innerHTML = '<p class="muted">分析中…</p>';
    try {
      const out = await api('/api/baby/cry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      renderCandidates(out);
    } catch (e) {
      cryResult.innerHTML = '<p class="error">' + esc(e.message) + '</p>'
        + (e.data && e.data.babies ? '<p class="muted">多个宝宝 — 升级以选择。</p>' : '');
    }
  });

  // ── Quick log chips / 快速记录 ────────────────────────────────────────
  const quickForm = document.getElementById('quick-form');
  const quickInput = document.getElementById('quick-input');
  const quickSend = document.getElementById('quick-send');
  const quickCancel = document.getElementById('quick-cancel');
  const quickStatus = document.getElementById('quick-status');

  document.querySelectorAll('.chip[data-quick]').forEach((el) => {
    el.addEventListener('click', () => {
      quickInput.value = el.dataset.quick || '';
      quickForm.hidden = false;
      quickStatus.textContent = '';
      quickInput.focus();
    });
  });
  quickCancel.addEventListener('click', () => { quickForm.hidden = true; });
  quickSend.addEventListener('click', async () => {
    const text = (quickInput.value || '').trim();
    if (!text) return;
    quickStatus.textContent = '提交中…';
    try {
      const out = await api('/api/captures', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, channel: 'web' }),
      });
      quickStatus.textContent = '已' + (out.status === 'committed' ? '入库' : (out.status === 'pending' ? '挂起待确认' : esc(out.status || 'ok')));
      quickForm.hidden = true;
    } catch (e) {
      quickStatus.textContent = '失败：' + esc(e.message);
    }
  });

  // ── Inbox / 收件 ──────────────────────────────────────────────────────
  const inboxList = document.getElementById('inbox-list');
  async function loadInbox() {
    inboxList.innerHTML = '<p class="muted">加载中…</p>';
    try {
      const items = await api('/api/captures?limit=50');
      if (!items.length) { inboxList.innerHTML = '<p class="muted">收件箱空 — 没有待确认。</p>'; return; }
      inboxList.innerHTML = items.map((it) => {
        const intent = it.suggestion && it.suggestion.intent ? it.suggestion.intent : '(no suggestion)';
        return ''
          + '<div class="row" data-id="' + esc(it.id) + '">'
          +   '<div class="row-title">' + esc(it.title || it.body || '') + '</div>'
          +   '<div class="row-meta">'
          +     '<span class="chip-tiny">' + esc(it.data && it.data.kind || 'text') + '</span>'
          +     '<span class="chip-tiny">' + esc(intent) + '</span>'
          +     '<span>' + esc((it.occurred_at || '').replace('T', ' ').slice(0, 16)) + '</span>'
          +   '</div>'
          +   '<div class="row-actions">'
          +     '<button data-act="confirm">确认</button>'
          +     '<button data-act="dismiss" class="muted-btn">忽略</button>'
          +   '</div>'
          + '</div>';
      }).join('');
    } catch (e) {
      inboxList.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }
  inboxList.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.row');
    const id = row && row.dataset.id;
    if (!id) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'confirm') {
        await api('/api/captures/' + encodeURIComponent(id) + '/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
      } else {
        await api('/api/captures/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' });
      }
      await loadInbox();
    } catch (e) {
      btn.disabled = false;
      alert(e.message);
    }
  });

  // ── Search / 找 ──────────────────────────────────────────────────────
  const qInput = document.getElementById('q');
  const qGo = document.getElementById('q-go');
  const searchList = document.getElementById('search-list');
  async function doSearch() {
    const q = (qInput.value || '').trim();
    if (!q) { searchList.innerHTML = ''; return; }
    searchList.innerHTML = '<p class="muted">搜索中…</p>';
    try {
      const hits = await api('/api/search?q=' + encodeURIComponent(q) + '&limit=25');
      if (!hits.length) { searchList.innerHTML = '<p class="muted">无结果。</p>'; return; }
      searchList.innerHTML = hits.map((h) => {
        const url = h.data && h.data.url;
        const title = url
          ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(h.title || h.id) + '</a>'
          : esc(h.title || h.id);
        return ''
          + '<div class="row">'
          +   '<div class="row-title">' + title + '</div>'
          +   '<div class="row-meta">'
          +     '<span class="chip-tiny">' + esc(h.type) + '</span>'
          +     (h.summary ? '<span>' + esc(h.summary.slice(0, 120)) + '</span>' : '')
          +   '</div>'
          + '</div>';
      }).join('');
    } catch (e) {
      searchList.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }
  qGo.addEventListener('click', doSearch);
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // ── Stats / 状态 ─────────────────────────────────────────────────────
  const statsBody = document.getElementById('stats-body');
  async function loadStats() {
    statsBody.innerHTML = '<p class="muted">加载中…</p>';
    try {
      const s = await api('/api/stats');
      const types = s.types || {};
      const rows = Object.entries(types).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('');
      statsBody.innerHTML = ''
        + '<dl>'
        +   '<dt>total</dt><dd>' + (s.total || 0) + '</dd>'
        +   '<dt>relations</dt><dd>' + (s.relations || 0) + '</dd>'
        + '</dl>'
        + '<h3>by type</h3>'
        + '<dl>' + rows + '</dl>';
    } catch (e) {
      statsBody.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }

  // ── Service worker (best-effort). Stale-while-revalidate for the shell.
  //    SW 注册失败时只记录日志，不影响 localhost http dev。 ──────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // eslint-disable-next-line no-console
      console.log('[lifeos] sw register skipped:', err && err.message);
    });
  }

  // initial route / 初次路由
  if (!location.hash) location.hash = '#baby';
  showTab(tabFromHash());
})();
