const CATEGORIES = {};
const LOCATIONS = {};
let CATEGORY_STATS = {};
let MANUAL_RECENT = [];
let _brandSegTimer = null;
let allItems = [];
let restockItems = [];
/** null = 显示全部渠道；Set = 仅显示集合内渠道（可为空集） */
let restockChannelFilter = null;
let purchaseChannelList = [];

/* ─── SSE streaming fetch utility ─────────────────────────────────────────── */

/**
 * POST with SSE streaming support. If server responds with text/event-stream,
 * reads chunks and calls onChunk; returns the final result from the stream.
 * Falls back to regular JSON parsing for non-streaming responses.
 *
 * @param {string} url
 * @param {object} body
 * @param {(chunk: string) => void} onChunk - called for each text chunk
 * @param {AbortSignal} [signal] - optional abort signal
 * @returns {Promise<object>} - final result object from the stream or JSON response
 */
async function fetchWithStreaming(url, body, onChunk, signal) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  const ct = resp.headers.get('content-type') || '';
  // Non-streaming response (HTTP backend or error)
  if (!ct.includes('text/event-stream')) {
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  // SSE streaming response
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finalResult = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Parse complete SSE events (delimited by \n\n)
    const parts = buf.split('\n\n');
    buf = parts.pop(); // keep incomplete tail
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }
        if (evt.chunk && onChunk) onChunk(evt.chunk);
        if (evt.error) throw new Error(evt.error);
        if (evt.result) finalResult = evt.result;
      }
    }
  }

  // Process any remaining buffer
  if (buf.trim()) {
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(6)); } catch { continue; }
      if (evt.chunk && onChunk) onChunk(evt.chunk);
      if (evt.error) throw new Error(evt.error);
      if (evt.result) finalResult = evt.result;
    }
  }

  if (!finalResult) throw new Error('流式响应未返回最终结果');
  return finalResult;
}
const sourcePickerState = { f: [], d: [] };
let currentFilter = 'all';
let scanner = null;
let mealDiaryData = null;
let familyPrefs = null;
let cachedLlmSubtitle = '';
let cachedLlmKey = '';

function urgentDaysClient() {
  const n = familyPrefs && familyPrefs.alerts && familyPrefs.alerts.urgent_days;
  return typeof n === 'number' && n >= 0 ? n : 3;
}

function warningDaysClient() {
  const n = familyPrefs && familyPrefs.alerts && familyPrefs.alerts.warning_days;
  return typeof n === 'number' && n >= 0 ? n : 7;
}

function inventorySubtitleCacheKey() {
  const th = urgentDaysClient();
  const urgent = allItems.filter((i) => i.days_left <= th).length;
  return `${allItems.length}:${urgent}:${th}`;
}

function updateSettingsSubtitleModeVisibility() {
  const sm = document.getElementById('settings-subtitle-mode');
  const block = document.getElementById('settings-llm-block');
  if (!sm || !block) return;
  block.style.display = sm.value === 'llm' ? 'block' : 'none';
  if (sm.value === 'llm') updateSettingsLlmBackendVisibility();
}

function updateSettingsLlmBackendVisibility() {
  const b = document.getElementById('settings-llm-backend')?.value || 'http';
  const httpBlock = document.getElementById('settings-llm-http-block');
  const cliBlock = document.getElementById('settings-llm-cli-block');
  if (httpBlock) httpBlock.style.display = b === 'http' ? 'block' : 'none';
  if (cliBlock) cliBlock.style.display = b === 'cli' ? 'block' : 'none';
}

function applyLlmCliPreset(preset) {
  const cmdEl = document.getElementById('settings-llm-cli-command');
  const argsEl = document.getElementById('settings-llm-cli-args');
  if (!cmdEl || !argsEl) return;
  const map = {
    claude: { command: 'claude', args: '["-p","<<<PROMPT>>>"]' },
    openclaw: { command: 'openclaw', args: '["run","--prompt","<<<PROMPT>>>"]' },
    gemini: { command: 'gemini', args: '["-p","<<<PROMPT>>>"]' },
    codex: { command: 'codex', args: '["-p","<<<PROMPT>>>"]' },
  };
  const m = map[preset];
  if (!m) return;
  cmdEl.value = m.command;
  argsEl.value = m.args;
}

async function saveSettingsSubtitle() {
  const sm = document.getElementById('settings-subtitle-mode');
  const mode = sm ? sm.value : 'default';
  const ui = {
    inventory_subtitle_mode: mode,
    inventory_subtitle_template: document.getElementById('settings-subtitle-template')?.value ?? '',
    inventory_subtitle_urgent_template: document.getElementById('settings-subtitle-urgent-template')?.value ?? '',
  };
  const backend = document.getElementById('settings-llm-backend')?.value || 'http';
  const llm = {
    backend,
    completion_url: document.getElementById('settings-llm-url')?.value?.trim() ?? '',
    model: document.getElementById('settings-llm-model')?.value?.trim() ?? '',
    auth_style: document.getElementById('settings-llm-auth')?.value ?? 'bearer',
    user_prompt_template: document.getElementById('settings-llm-user-prompt')?.value ?? '',
    body_template: document.getElementById('settings-llm-body-template')?.value ?? '',
    cli_command: document.getElementById('settings-llm-cli-command')?.value?.trim() ?? '',
    cli_cwd: document.getElementById('settings-llm-cli-cwd')?.value?.trim() ?? '',
  };
  const cliArgsRaw = document.getElementById('settings-llm-cli-args')?.value?.trim() ?? '';
  if (cliArgsRaw) {
    try {
      const parsed = JSON.parse(cliArgsRaw);
      if (!Array.isArray(parsed)) {
        showToast('CLI 参数须为 JSON 数组');
        return;
      }
      llm.cli_args = parsed;
    } catch (e) {
      showToast('CLI 参数 JSON 无效');
      return;
    }
  } else {
    llm.cli_args = [];
  }
  const toEl = document.getElementById('settings-llm-cli-timeout');
  if (toEl && toEl.value !== '') {
    const n = parseInt(toEl.value, 10);
    if (!Number.isNaN(n) && n >= 5000 && n <= 600000) llm.cli_timeout_ms = n;
  }
  const keyInput = document.getElementById('settings-llm-api-key');
  if (keyInput && keyInput.value.trim()) {
    llm.api_key = keyInput.value.trim();
  }
  try {
    const r = await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui, llm }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '保存失败');
      return;
    }
    familyPrefs = d.preferences;
    cachedLlmSubtitle = '';
    cachedLlmKey = '';
    if (keyInput) {
      keyInput.value = '';
      keyInput.placeholder =
        familyPrefs.llm && familyPrefs.llm.api_key_set ? '已保存 · 输入新值可覆盖' : '填写 API Key';
    }
    showToast('已保存');
    updateHeaderSubtitle();
  } catch (e) {
    showToast('网络错误');
  }
}

async function maybeRefreshLlmSubtitle() {
  const mode = familyPrefs && familyPrefs.ui && familyPrefs.ui.inventory_subtitle_mode;
  if (mode !== 'llm') return;
  const key = inventorySubtitleCacheKey();
  if (key === cachedLlmKey && cachedLlmSubtitle) return;
  const th = urgentDaysClient();
  const urgent = allItems.filter((i) => i.days_left <= th).length;
  if (urgent > 0) return;
  try {
    const r = await fetch('/api/inventory-subtitle/llm', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      cachedLlmSubtitle = d.error ? String(d.error).slice(0, 120) : '生成失败';
      cachedLlmKey = key;
      updateHeaderSubtitle();
      return;
    }
    if (d.subtitle) {
      cachedLlmSubtitle = d.subtitle;
      cachedLlmKey = key;
      updateHeaderSubtitle();
    }
  } catch (e) {
    cachedLlmSubtitle = '网络错误';
    cachedLlmKey = key;
    updateHeaderSubtitle();
  }
}
let _invSwipe = { startX: 0, startY: 0, id: null };
let transitData = null;
let transitPanelIndex = 0;

function normalizeSourcesClient(arr) {
  if (!arr || !Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw ?? '').trim().slice(0, 64);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function getItemSources(item) {
  if (item.sources && Array.isArray(item.sources) && item.sources.length) {
    return normalizeSourcesClient(item.sources);
  }
  if (item.source != null && String(item.source).trim()) {
    return [String(item.source).trim()];
  }
  return [];
}

function sourcesFromEntry(entry) {
  if (entry.sources && Array.isArray(entry.sources)) return normalizeSourcesClient(entry.sources);
  if (entry.source) return normalizeSourcesClient([entry.source]);
  return [];
}

function setSourcePicker(key, arr) {
  sourcePickerState[key] = normalizeSourcesClient(arr);
  renderSourceChips(key);
}

function getSourcePicker(key) {
  const el = document.getElementById(key + '-source-input');
  if (el) {
    const v = el.value.trim();
    if (v && !sourcePickerState[key].includes(v)) {
      sourcePickerState[key].push(v);
      ensurePurchaseChannelSaved(v);
    }
    el.value = '';
    renderSourceChips(key);
  }
  return [...sourcePickerState[key]];
}

async function loadPurchaseChannels() {
  try {
    const r = await fetch('/api/purchase-channels');
    const d = await r.json();
    purchaseChannelList = d.channels || [];
    const dl = document.getElementById('purchase-channel-datalist');
    if (dl) {
      dl.innerHTML = purchaseChannelList.map((c) => `<option value="${escapeHtml(c)}">`).join('');
    }
  } catch (e) {
    purchaseChannelList = [];
  }
}

async function ensurePurchaseChannelSaved(name) {
  const n = (name || '').trim();
  if (!n) return;
  try {
    await fetch('/api/purchase-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: n }),
    });
    await loadPurchaseChannels();
  } catch (e) {}
}

function renderSourceChips(key) {
  const el = document.getElementById(key === 'f' ? 'f-source-chips' : 'd-source-chips');
  if (!el) return;
  const arr = sourcePickerState[key];
  el.innerHTML = arr
    .map(
      (s, i) =>
        `<span class="source-chip">${escapeHtml(s)}<button type="button" class="source-chip-x" onclick="removeSourceChip('${key}',${i})">×</button></span>`
    )
    .join('');
}

function removeSourceChip(key, idx) {
  sourcePickerState[key].splice(idx, 1);
  renderSourceChips(key);
}

function addSourceChipFromInput(key) {
  const id = key === 'f' ? 'f-source-input' : 'd-source-input';
  const inp = document.getElementById(id);
  if (!inp) return;
  const v = (inp.value || '').trim();
  if (!v) return;
  if (!sourcePickerState[key].includes(v)) sourcePickerState[key].push(v);
  inp.value = '';
  renderSourceChips(key);
  ensurePurchaseChannelSaved(v);
}

function getRestockChannelsFromItems() {
  const set = new Set();
  restockItems.forEach((item) => {
    const srcs = getItemSources(item);
    if (srcs.length) srcs.forEach((c) => set.add(c));
    else set.add('未设置渠道');
  });
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function isRestockChannelSelected(ch) {
  if (restockChannelFilter === null) return true;
  return restockChannelFilter.has(ch);
}

function toggleRestockChannel(ch, checked) {
  const all = getRestockChannelsFromItems();
  if (restockChannelFilter === null) {
    restockChannelFilter = new Set(all);
  }
  if (checked) restockChannelFilter.add(ch);
  else restockChannelFilter.delete(ch);
  if (restockChannelFilter.size === all.length) {
    restockChannelFilter = null;
  }
  renderRestock();
}

function onRestockChannelCheck(index, checked) {
  const channels = getRestockChannelsFromItems();
  const ch = channels[index];
  if (ch === undefined) return;
  toggleRestockChannel(ch, checked);
}

function setRestockFilterAll() {
  restockChannelFilter = null;
  renderRestock();
}

function exportRestockMarkdown() {
  const channels = getRestockChannelsFromItems().filter((ch) => isRestockChannelSelected(ch));
  if (channels.length === 0) {
    showToast('没有可导出的渠道（请先勾选上方渠道）');
    return;
  }
  const urgencyOrder = { overdue: 0, urgent: 1, soon: 2 };
  let md = '';
  for (const ch of channels) {
    const items = restockItems
      .filter((item) => {
        const srcs = getItemSources(item);
        const keys = srcs.length ? srcs : ['未设置渠道'];
        return keys.includes(ch);
      })
      .sort(
        (a, b) =>
          urgencyOrder[a.prediction.restock_urgency] -
          urgencyOrder[b.prediction.restock_urgency]
      );
    if (items.length === 0) continue;
    md += `## ${ch}\n\n`;
    items.forEach((item) => {
      if (item.pending_only) {
        md += `- [ ] 🟠 ${item.name}（做菜待买）\n`;
        return;
      }
      const p = item.prediction;
      const mark =
        p.restock_urgency === 'overdue' ? '🔴' : p.restock_urgency === 'urgent' ? '🟠' : '🟡';
      const line = p.restock_date ? `${p.restock_date} 前补` : '尽快补货';
      md += `- [ ] ${mark} ${item.name}（库存 ${item.quantity}${item.unit}，${line}）\n`;
    });
    md += '\n';
  }
  if (!md.trim()) {
    showToast('当前筛选下没有补货项');
    return;
  }
  const done = () => showToast('已复制 Markdown 到剪贴板');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(md).then(done).catch(fallbackCopy);
  } else fallbackCopy();
  function fallbackCopy() {
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      showToast('复制失败，请手动复制');
    }
    document.body.removeChild(ta);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 解析 fetch 结果为 JSON；若收到 HTML 错误页则抛出可读中文错误（避免 Unexpected token '<'） */
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const hint =
      r.status === 404
        ? '接口不存在（请确认已重启 node 服务并打开的是本页所在域名/端口）'
        : '服务器返回了非 JSON（可能是错误页）';
    throw new Error(`${hint} · HTTP ${r.status}`);
  }
  if (!r.ok) {
    throw new Error(data.error || data.message || `请求失败（HTTP ${r.status}）`);
  }
  return data;
}

/** 无自定义图标时按品类给默认 emoji（Notion 式展示） */
const CATEGORY_ICONS = {
  dairy: '🥛', meat_fresh: '🥩', meat_frozen: '🧊', vegetable: '🥬', fruit: '🍎', grain: '🌾',
  snack: '🍪', beverage: '🥤', condiment: '🧂', diaper: '🩲', formula: '🍼', ready_to_feed: '🍼',
  baby_snack: '🍼', baby_food: '🥣', wipes: '🧻', medicine: '💊',
  personal_care: '🧴', cleaning: '🧽', other: '📦',
  clothing: '👔', home_misc: '🧰', digital_voucher: '🎫',
};

function itemDisplayIcon(item) {
  if (item.icon && String(item.icon).trim()) return String(item.icon).trim();
  return CATEGORY_ICONS[item.category] || '📦';
}

const MEAL_SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

/** 非「食材」展示/常买勾选：尿裤纸巾药品清洁个护等 */
const NON_COOKING_INGREDIENT_CATEGORIES = new Set([
  'diaper',
  'wipes',
  'medicine',
  'cleaning',
  'personal_care',
  'clothing',
  'home_misc',
  'digital_voucher',
  'ready_to_feed',
  'formula',
  'baby_snack',
  'baby_clothing',
  'baby_toys',
  'paper_goods',
  'appliances'
]);

function isCookingIngredientCategory(cat) {
  return cat && !NON_COOKING_INGREDIENT_CATEGORIES.has(cat);
}

let cookingReco = null;
/** @type {Array<{name:string,ingredients:string[],steps:string}>} */
let cookingLlmItems = [];

async function loadFamilyPrefs() {
  try {
    const r = await fetch('/api/preferences');
    familyPrefs = await r.json();
  } catch (e) {
    familyPrefs = null;
  }
  updateBabyTabVisibility();
  updateCarCareTabVisibility();
  updateTransitTabVisibility();
}

function uiShowTransitTab() {
  const v = familyPrefs && familyPrefs.ui && familyPrefs.ui.show_transit_tab;
  return v === true || v === 1 || v === 'true' || v === '1';
}

function updateCarCareTabVisibility() {
  const tab = document.getElementById('tab-carcare');
  if (!tab) return;
  const cars = (familyPrefs && familyPrefs.family && familyPrefs.family.cars) || [];
  if (cars.length > 0) {
    tab.style.display = 'flex';
  } else {
    tab.style.display = 'none';
    if (tab.classList.contains('active')) {
      switchTab('inventory');
    }
  }
}

function updateTransitTabVisibility() {
  const tab = document.getElementById('tab-transit');
  if (!tab) return;
  if (uiShowTransitTab()) {
    tab.style.display = 'flex';
  } else {
    tab.style.display = 'none';
    if (tab.classList.contains('active')) {
      switchTab('inventory');
    }
  }
}

function updateBabyTabVisibility() {
  const tab = document.getElementById('tab-baby');
  const lbl = document.getElementById('tab-baby-label');
  if (!tab) return;
  const babies = (familyPrefs && familyPrefs.family && familyPrefs.family.babies) || [];
  if (babies.length > 0) {
    tab.style.display = 'flex';
    if (lbl) lbl.textContent = babies.map((b) => b.name).join('·');
  } else {
    tab.style.display = 'none';
    if (tab.classList.contains('active')) {
      switchTab('inventory');
    }
  }
}

async function loadCookingUI() {
  try {
    await refreshInventory();
    if (!familyPrefs) await loadFamilyPrefs();
    const [mealData, recoData] = await Promise.all([
      fetchJson('/api/meal-diary'),
      fetchJson('/api/cooking-recommendations'),
    ]);
    mealDiaryData = mealData;
    cookingReco = recoData;
    renderCookingMealDishSelect();
    renderCookingFavorites();
    renderCookingRecommendations();
    renderCookingLlmControls();
    renderCookingLlmRecos();
    renderCookingIngredients();
    renderCookingRecentMeals();
  } catch (e) {
    showToast(e.message || '加载餐食数据失败');
  }
}

function renderCookingRecommendations() {
  const topEl = document.getElementById('cook-top-dishes');
  const gapEl = document.getElementById('cook-gap-one');
  if (!topEl || !gapEl) return;
  if (!cookingReco) {
    topEl.innerHTML = '—';
    gapEl.innerHTML = '—';
    return;
  }
  const top = cookingReco.top_dishes || [];
  topEl.innerHTML = top.length
    ? `<div><span style="color:var(--subtext)">常吃 Top5：</span>${top
        .map((t) => `${escapeHtml(t.name)} ×${t.count}`)
        .join(' · ')}</div>`
    : '<span style="color:var(--subtext)">多记几餐后，这里会显示最常吃的菜</span>';
  const gaps = cookingReco.gap_one || [];
  gapEl.innerHTML = gaps.length
    ? `<div style="margin-top:6px"><span style="color:var(--subtext)">只差 1 样食材：</span></div>${gaps
        .map(
          (g) =>
            `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;flex-wrap:wrap;border-bottom:0.5px solid var(--border);padding-bottom:8px">
            <span>${escapeHtml(g.name)} · 缺 <b>${escapeHtml(g.missing)}</b>${g.eat_count ? `（吃过 ${g.eat_count} 次）` : ''}</span>
            <button type="button" class="source-add-btn" onclick="addCookingRestockGap(${JSON.stringify(g.missing)})">一键加入补货</button>
          </div>`
        )
        .join('')}`
    : '<span style="color:var(--subtext)">暂无「只差一种食材」的菜谱推荐</span>';
}

function renderCookingLlmControls() {
  const ok = !!(familyPrefs && familyPrefs.llm_cooking_ready);
  const hint = document.getElementById('cook-llm-disabled-hint');
  const btn = document.getElementById('cook-llm-btn');
  const input = document.getElementById('cook-llm-hint');
  if (hint) hint.style.display = ok ? 'none' : 'block';
  if (btn) btn.disabled = !ok;
  if (input) input.disabled = !ok;
}

function renderCookingLlmRecos() {
  const el = document.getElementById('cook-llm-recos');
  if (!el) return;
  if (!cookingLlmItems.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = cookingLlmItems
    .map((d, idx) => {
      const ing = (d.ingredients || []).map((x) => escapeHtml(x)).join('、') || '—';
      const stepsHtml = escapeHtml(d.steps || '').replace(/\n/g, '<br>');
      return `<div style="margin-top:10px;padding:10px;border-radius:8px;border:0.5px solid var(--border)">
        <div style="font-weight:600;margin-bottom:6px">${escapeHtml(d.name)}</div>
        <div style="font-size:12px;color:var(--subtext);margin-bottom:6px">用料：${ing}</div>
        <details style="font-size:13px" id="llm-expand-steps-${idx}">
          <summary style="cursor:pointer;user-select:none;color:var(--accent)">做法</summary>
          <div style="margin-top:8px;line-height:1.5;font-size:13px;white-space:pre-wrap">${stepsHtml || '<span style="color:var(--subtext)">（无）</span>'}</div>
        </details>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
          <button type="button" class="source-add-btn" onclick="expandCookingLlmSteps(${idx})">展开更详细做法</button>
          <button type="button" class="source-add-btn" onclick="fillCookingFormFromLlm(${idx})">填入新建菜谱</button>
        </div>
      </div>`;
    })
    .join('');
}

async function fetchCookingLlmRecommendations() {
  if (!familyPrefs || !familyPrefs.llm_cooking_ready) {
    showToast('请先配置 LLM');
    return;
  }
  const btn = document.getElementById('cook-llm-btn');
  const hint = (document.getElementById('cook-llm-hint') && document.getElementById('cook-llm-hint').value) || '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中…';
  }
  // Show streaming progress area
  const recosEl = document.getElementById('cook-llm-recos');
  if (recosEl) recosEl.innerHTML = '<div class="llm-stream-progress" id="llm-stream-text">等待模型响应…</div>';
  const ac = new AbortController();
  try {
    const d = await fetchWithStreaming(
      '/api/cooking/llm-recommendations',
      { count: 5, hint: hint.trim() },
      (chunk) => {
        const el = document.getElementById('llm-stream-text');
        if (el) {
          if (el.textContent === '等待模型响应…') el.textContent = '';
          el.textContent += chunk;
          el.scrollTop = el.scrollHeight;
        }
      },
      ac.signal,
    );
    cookingLlmItems = Array.isArray(d.dishes) ? d.dishes : [];
    renderCookingLlmRecos();
    if (!cookingLlmItems.length) showToast('未返回菜谱');
    else showToast(`已生成 ${cookingLlmItems.length} 道菜`);
  } catch (e) {
    if (e.name !== 'AbortError') showToast(e.message || '网络错误');
  } finally {
    if (btn) {
      btn.disabled = !familyPrefs.llm_cooking_ready;
      btn.textContent = '大模型生成推荐菜';
    }
  }
}

async function expandCookingLlmSteps(idx) {
  const d = cookingLlmItems[idx];
  if (!d || !familyPrefs || !familyPrefs.llm_cooking_ready) return;
  showToast('正在展开做法…');
  // Show inline streaming progress
  const stepsEl = document.getElementById('llm-expand-steps-' + idx);
  if (stepsEl) stepsEl.innerHTML = '<div class="llm-stream-progress" id="llm-expand-stream-' + idx + '">等待模型响应…</div>';
  try {
    const out = await fetchWithStreaming(
      '/api/cooking/llm-expand-steps',
      { name: d.name, ingredients: d.ingredients || [], steps_brief: d.steps || '' },
      (chunk) => {
        const el = document.getElementById('llm-expand-stream-' + idx);
        if (el) {
          if (el.textContent === '等待模型响应…') el.textContent = '';
          el.textContent += chunk;
          el.scrollTop = el.scrollHeight;
        }
      },
    );
    cookingLlmItems[idx] = { ...d, steps: out.steps || d.steps };
    renderCookingLlmRecos();
    showToast('已更新做法');
  } catch (e) {
    showToast(e.message || '网络错误');
  }
}

function fillCookingFormFromLlm(idx) {
  const d = cookingLlmItems[idx];
  if (!d) return;
  const nameEl = document.getElementById('dish-name');
  const ingEl = document.getElementById('dish-ing-lines');
  const stepsEl = document.getElementById('dish-steps');
  if (nameEl) nameEl.value = d.name || '';
  if (ingEl) ingEl.value = (d.ingredients || []).join('\n');
  if (stepsEl) stepsEl.value = d.steps || '';
  showToast('已填入下方「新建菜谱」');
  nameEl && nameEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function addCookingRestockGap(name) {
  try {
    const r = await fetch('/api/cooking/add-restock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ingredient_name: name }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '失败');
      return;
    }
    showToast(d.mode === 'inventory' ? '已在库存中标记需补货' : '已加入做菜待买（补货 Tab）');
    await refreshInventory();
    await loadCookingUI();
    if (document.getElementById('page-restock')?.classList.contains('active')) renderRestock();
  } catch (e) {
    showToast('网络错误');
  }
}

async function patchIngredientFrequent(id, checked) {
  try {
    await fetch(`/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequent_restock: !!checked }),
    });
    showToast(checked ? '已标为常买食材' : '已取消常买');
    await refreshInventory();
    renderCookingIngredients();
    renderInventory();
  } catch (e) {
    showToast('保存失败');
  }
}

function renderCookingMealDishSelect() {
  const sel = document.getElementById('meal-dish-ids');
  if (!sel || !mealDiaryData) return;
  sel.innerHTML = (mealDiaryData.dishes || [])
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
    .join('');
}

function renderCookingFavorites() {
  const el = document.getElementById('cook-favorites');
  if (!el || !mealDiaryData) return;
  const favs = (mealDiaryData.dishes || []).filter((d) => d.favorite);
  if (favs.length === 0) {
    el.innerHTML = '<span style="color:var(--subtext)">暂无，新建菜谱时勾选「加入收藏」</span>';
    return;
  }
  el.innerHTML = favs
    .map(
      (d) =>
        `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">⭐ <span>${escapeHtml(d.name)}</span> <button type="button" class="source-add-btn" onclick="toggleDishFavorite('${d.id}',false)">取消收藏</button></div>`
    )
    .join('');
}

async function toggleDishFavorite(id, fav) {
  try {
    await fetch(`/api/meal-diary/dishes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: !!fav }),
    });
    await loadCookingUI();
  } catch (e) {
    showToast('操作失败');
  }
}

function renderCookingIngredients() {
  const el = document.getElementById('cook-ingredients');
  if (!el) return;
  const items = (allItems || []).filter(
    (i) => i.status === 'in_stock' && isCookingIngredientCategory(i.category)
  );
  if (!items.length) {
    el.innerHTML =
      '<span style="color:var(--subtext)">暂无符合条件的库存，请先在库存 Tab 入库（排除尿裤/药品等非食材品类）</span>';
    return;
  }
  el.innerHTML = items
    .map((i) => {
      const ic = escapeHtml(itemDisplayIcon(i));
      const nm = escapeHtml(i.name);
      const fq = !!i.frequent_restock;
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span><span class="inv-emoji">${ic}</span> ${nm} <span style="font-size:12px;color:var(--subtext)">${escapeHtml(
        i.category_label || ''
      )} · ${i.quantity}${i.unit}</span></span>
        <label class="form-check" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;margin:0">
          <input type="checkbox" ${fq ? 'checked' : ''} onchange="patchIngredientFrequent('${i.id}', this.checked)"> 常买
        </label>
      </div>`;
    })
    .join('');
}

function renderCookingRecentMeals() {
  const el = document.getElementById('cook-recent-meals');
  if (!el || !mealDiaryData) return;
  const meals = (mealDiaryData.meals || [])
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15);
  if (!meals.length) {
    el.innerHTML = '<span style="color:var(--subtext)">暂无</span>';
    return;
  }
  el.innerHTML = meals
    .map((m) => {
      const slot = MEAL_SLOT_LABELS[m.slot] || m.slot;
      const names = (m.dish_ids || [])
        .map((id) => {
          const d = (mealDiaryData.dishes || []).find((x) => x.id === id);
          return d ? d.name : id;
        })
        .join('、');
      return `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:0.5px solid var(--border)"><b>${m.date}</b> ${slot} ${names ? '· ' + escapeHtml(names) : ''}${m.notes ? '<br><span style="color:var(--subtext)">' + escapeHtml(m.notes) + '</span>' : ''}</div>`;
    })
    .join('');
}

function getSelectedDishIds() {
  const sel = document.getElementById('meal-dish-ids');
  if (!sel) return [];
  return Array.from(sel.selectedOptions).map((o) => o.value);
}

async function submitMealEntry() {
  const date = document.getElementById('meal-date').value;
  const slot = document.getElementById('meal-slot').value;
  const dish_ids = getSelectedDishIds();
  const notes = (document.getElementById('meal-notes').value || '').trim();
  if (!date) {
    showToast('请选择日期');
    return;
  }
  try {
    const r = await fetch('/api/meal-diary/meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, slot, dish_ids, notes }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '保存失败');
      return;
    }
    showToast('已记录这一餐');
    document.getElementById('meal-notes').value = '';
    await loadCookingUI();
  } catch (e) {
    showToast('网络错误');
  }
}

async function submitNewDish() {
  const name = (document.getElementById('dish-name').value || '').trim();
  const lines = (document.getElementById('dish-ing-lines').value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const ingredient_refs = lines.map((text) => ({ text }));
  const steps = (document.getElementById('dish-steps').value || '').trim();
  const favorite = document.getElementById('dish-favorite').checked;
  if (!name) {
    showToast('请填写菜名');
    return;
  }
  try {
    const r = await fetch('/api/meal-diary/dishes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ingredient_refs, steps, favorite, notes: '' }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '失败');
      return;
    }
    showToast('已保存菜谱');
    document.getElementById('dish-name').value = '';
    document.getElementById('dish-ing-lines').value = '';
    document.getElementById('dish-steps').value = '';
    document.getElementById('dish-favorite').checked = false;
    await loadCookingUI();
  } catch (e) {
    showToast('网络错误');
  }
}

function shiftCalendarMonth(delta) {
  const el = document.getElementById('cal-month');
  if (!el || !el.value) return;
  const [y, m] = el.value.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  el.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadCalendarMonth();
}

async function loadCalendarMonth() {
  const el = document.getElementById('cal-month');
  const body = document.getElementById('calendar-grid-body');
  if (!el || !body) return;
  const v = el.value || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = v.split('-').map(Number);
  const from = `${v}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${v}-${String(last).padStart(2, '0')}`;
  body.innerHTML = '<div class="loading"><div class="spinner"></div> 加载中…</div>';
  try {
    const [rCal, rMeal] = await Promise.all([
      fetch(`/api/calendar?from=${from}&to=${to}`),
      fetch('/api/meal-diary'),
    ]);
    const cal = await rCal.json();
    mealDiaryData = await rMeal.json();
    renderCalendarBody(cal);
  } catch (e) {
    body.innerHTML = '<div class="empty">加载失败</div>';
  }
}

let currentCalendarData = null;

function renderCalendarBody(api) {
  currentCalendarData = api;
  const body = document.getElementById('calendar-grid-body');
  const elMonth = document.getElementById('cal-month');
  if (!body || !elMonth) return;

  const v = elMonth.value || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const [y, m] = v.split('-').map(Number);
  
  // Calculate stats
  let totalMeals = 0;
  let totalBaby = 0;
  let totalRestock = 0;
  Object.values(api.days || {}).forEach(D => {
    if (D.meals) totalMeals += D.meals.length;
    if (D.baby_events) totalBaby += D.baby_events.length;
    if (D.inventory_adds) totalRestock += D.inventory_adds.length;
  });
  
  const elMeals = document.getElementById('cal-stat-meals');
  const elBaby = document.getElementById('cal-stat-baby');
  const elInv = document.getElementById('cal-stat-restock');
  if (elMeals) elMeals.textContent = totalMeals;
  if (elBaby) elBaby.textContent = totalBaby;
  if (elInv) elInv.textContent = totalRestock;

  // Grid layout
  const firstDay = new Date(y, m - 1, 1).getDay();
  const lastDate = new Date(y, m, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  
  let html = '';
  // Empty slots
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="cal-cell cal-empty-cell"></div>';
  }
  
  for (let d = 1; d <= lastDate; d++) {
    const dStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dStr === todayStr;
    const D = api.days[dStr] || {};
    
    let sumHtml = '';
    if (D.baby_events && D.baby_events.length) {
      sumHtml += `<span class="cal-stat-baby">👶 ${D.baby_events.length}</span>`;
    }
    if (D.meals && D.meals.length) {
      // Find what was eaten
      const allNames = [];
      D.meals.forEach(meal => {
        (meal.dish_ids || []).forEach(did => {
          const dish = (mealDiaryData.dishes || []).find(x => x.id === did);
          if (dish) allNames.push(dish.name);
        });
      });
      const topDishes = allNames.slice(0, 2).map(escapeHtml).join('·');
      sumHtml += `<span class="cal-stat-meal">🍽 ${D.meals.length}${topDishes ? ' ' + topDishes : ''}</span>`;
    }
    if (D.inventory_adds && D.inventory_adds.length) {
      sumHtml += `<span class="cal-stat-inv">📦 ${D.inventory_adds.length}</span>`;
    }

    html += `
      <div class="cal-cell ${isToday ? 'today' : ''}" onclick="openTimelineModal('${dStr}')">
        <div class="cal-cell-day">${d}</div>
        <div class="cal-cell-summary">${sumHtml}</div>
      </div>
    `;
  }
  body.innerHTML = html;
}

function openTimelineModal(dateStr) {
  const modal = document.getElementById('timeline-modal');
  const title = document.getElementById('timeline-modal-title');
  const body = document.getElementById('timeline-body');
  if (!modal || !currentCalendarData) return;
  
  title.textContent = `${dateStr} 时间线`;
  const D = currentCalendarData.days[dateStr] || {};
  
  // Combine all events into a unified timeline
  const events = [];
  
  if (D.baby_events) {
    D.baby_events.forEach(ev => {
      events.push({
        time: ev.time || `${dateStr}T12:00`,
        sortTime: ev.time || `${dateStr}T12:00`,
        type: 'baby',
        label: ev.type,
        detail: ev.note || ''
      });
    });
  }
  if (D.meals) {
    D.meals.forEach(m => {
      // Fake time based on slot
      const tMap = { breakfast: '08:00', lunch: '12:30', dinner: '18:30', snack: '15:00' };
      const hm = tMap[m.slot] || '12:00';
      const slotName = MEAL_SLOT_LABELS[m.slot] || m.slot;
      const names = (m.dish_ids || []).map(id => {
        const d = (mealDiaryData.dishes || []).find(x => x.id === id);
        return d ? d.name : id;
      }).join('、');
      
      events.push({
        time: `${dateStr}T${hm}`,
        sortTime: `${dateStr}T${hm}`,
        type: 'meal',
        label: slotName + (names ? '：' + names : ''),
        detail: m.notes || ''
      });
    });
  }
  if (D.inventory_adds) {
    D.inventory_adds.forEach(a => {
      const src = (a.sources || []).length ? `（${a.sources.join('、')}）` : '';
      const tMap = a.created_at || `${dateStr}T19:00`;
      events.push({
        time: tMap,
        sortTime: tMap,
        type: 'inventory',
        label: `入库：${a.name}`,
        detail: `${a.quantity}${a.unit} ${src}`
      });
    });
  }
  
  events.sort((a, b) => a.sortTime.localeCompare(b.sortTime));
  
  if (events.length === 0) {
    body.innerHTML = '<div class="empty">本日无记录</div>';
  } else {
    body.innerHTML = events.map(ev => {
      const hm = ev.time.length >= 16 ? ev.time.slice(11,16) : ev.time;
      let icon = 'dot';
      let iconClass = 'timeline-icon-other';
      if (ev.type === 'baby') { icon = '👶'; iconClass = 'timeline-icon-growth'; }
      if (ev.type === 'meal') { icon = '🍽'; iconClass = 'timeline-icon-feeding'; }
      if (ev.type === 'inventory') { icon = '📦'; iconClass = 'timeline-icon-sleep'; }

      return `
        <div class="timeline-item">
          <div class="timeline-icon ${iconClass}">${icon}</div>
          <div class="timeline-body">
            <div class="timeline-title">${escapeHtml(ev.label)}</div>
            ${ev.detail ? `<div class="timeline-detail">${escapeHtml(ev.detail)}</div>` : ''}
          </div>
          <div class="timeline-time">${hm}</div>
        </div>
      `;
    }).join('');
  }
  
  modal.style.display = 'flex';
}

function closeTimelineModal(e) {
  if (e) e.stopPropagation();
  const modal = document.getElementById('timeline-modal');
  if (modal) modal.style.display = 'none';
}

async function loadSettingsUI() {
  await loadFamilyPrefs();
  const list = document.getElementById('settings-babies-list');
  if (list) {
    const babies = (familyPrefs && familyPrefs.family && familyPrefs.family.babies) || [];
    if (babies.length === 0) {
      list.innerHTML =
        '<p style="color:var(--subtext);font-size:13px">暂无。点击下方添加；保存为空列表可隐藏底部宝宝 Tab（不再从档案自动合并）。</p>';
    } else {
      list.innerHTML = babies
        .map(
          (b) =>
            `<div class="settings-baby-row" data-baby-id="${escapeHtml(b.id)}">
      <input class="form-input" data-field="name" value="${escapeHtml(b.name)}" placeholder="名字" style="flex:1;min-width:120px">
      <input type="date" class="form-input" data-field="dob" value="${b.dob || ''}" style="width:140px">
      <button type="button" class="source-add-btn" onclick="this.parentElement.remove()">删</button>
    </div>`
        )
        .join('');
    }
  }
  const carsList = document.getElementById('settings-cars-list');
  if (carsList) {
    const cars = (familyPrefs && familyPrefs.family && familyPrefs.family.cars) || [];
    if (cars.length === 0) {
      carsList.innerHTML =
        '<p style="color:var(--subtext);font-size:13px">暂无。点击下方添加车辆；数据保存在 config/cars.json。</p>';
    } else {
      carsList.innerHTML = cars
        .map(
          (c) =>
            `<div class="settings-car-row" data-car-id="${escapeHtml(c.id || '')}">
      <input class="form-input" data-field="name" value="${escapeHtml(c.name || '')}" placeholder="车名" style="flex:1;min-width:100px">
      <input class="form-input" data-field="plate" value="${escapeHtml(c.plate || '')}" placeholder="牌照（可选）" style="width:120px">
      <button type="button" class="source-add-btn" onclick="this.parentElement.remove()">删</button>
    </div>`
        )
        .join('');
    }
  }
  const transitCb = document.getElementById('settings-show-transit-tab');
  if (transitCb) {
    transitCb.checked = uiShowTransitTab();
  }
  const sm = document.getElementById('settings-subtitle-mode');
  if (sm) {
    const ui = (familyPrefs && familyPrefs.ui) || {};
    sm.value = ui.inventory_subtitle_mode || 'default';
    const tpl = document.getElementById('settings-subtitle-template');
    if (tpl) tpl.value = ui.inventory_subtitle_template || '';
    const utpl = document.getElementById('settings-subtitle-urgent-template');
    if (utpl) utpl.value = ui.inventory_subtitle_urgent_template || '';
    const llm = (familyPrefs && familyPrefs.llm) || {};
    const up = document.getElementById('settings-llm-user-prompt');
    if (up) up.value = llm.user_prompt_template || '';
    const modelEl = document.getElementById('settings-llm-model');
    if (modelEl) modelEl.value = llm.model || '';
    const backEl = document.getElementById('settings-llm-backend');
    if (backEl) backEl.value = llm.backend || 'http';
    const urlEl = document.getElementById('settings-llm-url');
    if (urlEl) urlEl.value = llm.completion_url || '';
    const authEl = document.getElementById('settings-llm-auth');
    if (authEl) authEl.value = llm.auth_style || 'bearer';
    const keyInput = document.getElementById('settings-llm-api-key');
    if (keyInput) {
      keyInput.value = '';
      keyInput.placeholder = llm.api_key_set ? '已保存 · 输入新值可覆盖' : '填写 API Key';
    }
    const bt = document.getElementById('settings-llm-body-template');
    if (bt) bt.value = llm.body_template || '';
    const cc = document.getElementById('settings-llm-cli-command');
    if (cc) cc.value = llm.cli_command || '';
    const ca = document.getElementById('settings-llm-cli-args');
    if (ca) {
      ca.value = Array.isArray(llm.cli_args) && llm.cli_args.length ? JSON.stringify(llm.cli_args) : '';
    }
    const cwdEl = document.getElementById('settings-llm-cli-cwd');
    if (cwdEl) cwdEl.value = llm.cli_cwd || '';
    const toEl = document.getElementById('settings-llm-cli-timeout');
    if (toEl) toEl.value = llm.cli_timeout_ms != null ? String(llm.cli_timeout_ms) : '120000';
    const presetSel = document.getElementById('settings-llm-cli-preset');
    if (presetSel) presetSel.selectedIndex = 0;
    updateSettingsSubtitleModeVisibility();
    updateSettingsLlmBackendVisibility();
    sm.onchange = updateSettingsSubtitleModeVisibility;
  }
}

async function saveSettingsUi() {
  const el = document.getElementById('settings-show-transit-tab');
  const show_transit_tab = !!(el && el.checked);
  try {
    const r = await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { show_transit_tab } }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '保存失败');
      return;
    }
    familyPrefs = d.preferences;
    showToast('已保存');
    updateTransitTabVisibility();
  } catch (e) {
    showToast('网络错误');
  }
}

function addSettingsBabyRow() {
  const list = document.getElementById('settings-babies-list');
  if (!list) return;
  if (list.querySelector('p')) list.innerHTML = '';
  const id = 'baby_' + Date.now();
  const div = document.createElement('div');
  div.className = 'settings-baby-row';
  div.dataset.babyId = id;
  div.innerHTML = `
    <input class="form-input" data-field="name" placeholder="名字" style="flex:1;min-width:120px">
    <input type="date" class="form-input" data-field="dob" style="width:140px">
    <button type="button" class="source-add-btn" onclick="this.parentElement.remove()">删</button>
  `;
  list.appendChild(div);
}

function addSettingsCarRow() {
  const list = document.getElementById('settings-cars-list');
  if (!list) return;
  if (list.querySelector('p')) list.innerHTML = '';
  const id = 'car_' + Date.now();
  const div = document.createElement('div');
  div.className = 'settings-car-row';
  div.dataset.carId = id;
  div.innerHTML = `
    <input class="form-input" data-field="name" placeholder="车名" style="flex:1;min-width:100px">
    <input class="form-input" data-field="plate" placeholder="牌照（可选）" style="width:120px">
    <button type="button" class="source-add-btn" onclick="this.parentElement.remove()">删</button>
  `;
  list.appendChild(div);
}

async function saveSettingsCars() {
  const list = document.getElementById('settings-cars-list');
  if (!list) return;
  let doc = { version: '1.0', vehicles: [] };
  try {
    doc = await fetchJson('/api/cars');
  } catch (e) {
    showToast(e.message || '加载失败');
    return;
  }
  const prevById = new Map((doc.vehicles || []).map((v) => [v.id, v]));
  const rows = list.querySelectorAll('.settings-car-row');
  const vehicles = [];
  rows.forEach((row) => {
    const name = row.querySelector('[data-field="name"]')?.value.trim();
    const plate = row.querySelector('[data-field="plate"]')?.value.trim() || '';
    if (!name) return;
    const id = row.dataset.carId || 'car_' + Date.now();
    const prev = prevById.get(id) || {};
    vehicles.push({
      ...prev,
      id,
      name,
      plate,
      schedule: Array.isArray(prev.schedule) ? prev.schedule : [],
    });
  });
  try {
    await fetchJson('/api/cars', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: doc.version || '1.0', vehicles }),
    });
    await loadFamilyPrefs();
    showToast('已保存');
    updateCarCareTabVisibility();
    loadCarCareUI();
  } catch (e) {
    showToast(e.message || '保存失败');
  }
}

async function saveSettingsBabies() {
  const list = document.getElementById('settings-babies-list');
  if (!list) return;
  const rows = list.querySelectorAll('.settings-baby-row');
  const babies = [];
  rows.forEach((row) => {
    const name = row.querySelector('[data-field="name"]')?.value.trim();
    const dob = row.querySelector('[data-field="dob"]')?.value || '';
    if (!name) return;
    babies.push({
      id: row.dataset.babyId || 'baby_' + Date.now(),
      name,
      dob: dob || null,
    });
  });
  try {
    const r = await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: { babies } }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '保存失败');
      return;
    }
    familyPrefs = d.preferences;
    showToast('已保存');
    updateBabyTabVisibility();
  } catch (e) {
    showToast('网络错误');
  }
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([
    loadCategories(),
    loadLocations(),
    loadCategoryStats(),
    loadManualImportRecent(),
    loadPurchaseChannels(),
  ]);
  populateCategorySelect();
  populateLocationSelect();
  await refreshDiaperSegmentOptions();
  renderRecentImportChips();
  sourcePickerState.f = [];
  renderSourceChips('f');
  const fb = document.getElementById('f-brand');
  if (fb) fb.addEventListener('input', scheduleBrandDiaperRefresh);
  const fsi = document.getElementById('f-source-input');
  if (fsi) {
    fsi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSourceChipFromInput('f');
      }
    });
  }
  const dsi = document.getElementById('d-source-input');
  if (dsi) {
    dsi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSourceChipFromInput('d');
      }
    });
  }
  await loadFamilyPrefs();
  await refreshInventory();
  setupBtcpDragDrop();
  updateHeaderAddVisibility();
  const cal = document.getElementById('cal-month');
  if (cal && !cal.value) {
    const d = new Date();
    cal.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const mealDate = document.getElementById('meal-date');
  if (mealDate && !mealDate.value) {
    mealDate.value = new Date().toISOString().slice(0, 10);
  }
  await loadCryptoHint();
}

async function loadCryptoHint() {
  try {
    const r = await fetch('/api/crypto-status');
    const d = await r.json();
    const hint = document.getElementById('f-crypto-hint');
    if (!hint) return;
    if (!d.encryption_enabled) {
      hint.style.display = 'block';
      hint.textContent =
        '⚠️ 未配置 HOUSEHOLD_ENCRYPTION_KEY（64 位十六进制），礼品卡/券码无法加密保存。在 .env 中设置后重启 node。';
    } else {
      hint.style.display = 'none';
    }
  } catch (e) {}
}

function scheduleBrandDiaperRefresh() {
  clearTimeout(_brandSegTimer);
  _brandSegTimer = setTimeout(() => {
    if (document.getElementById('f-category').value === 'diaper') {
      refreshDiaperSegmentOptions();
    }
  }, 350);
}

async function loadCategoryStats() {
  try {
    const r = await fetch('/api/category-stats');
    const d = await r.json();
    CATEGORY_STATS = d.counts || {};
  } catch (e) {
    CATEGORY_STATS = {};
  }
}

async function loadManualImportRecent() {
  try {
    const r = await fetch('/api/manual-import-recent');
    const d = await r.json();
    MANUAL_RECENT = d.entries || [];
  } catch (e) {
    MANUAL_RECENT = [];
  }
}

function renderRecentImportChips() {
  const strip = document.getElementById('recent-imports-strip');
  if (!strip) return;
  const entries = MANUAL_RECENT || [];
  if (!entries.length) {
    strip.innerHTML =
      '<span style="font-size:12px;color:var(--subtext)">尚无记录，成功入库后会出现在这里</span>';
    return;
  }
  strip.innerHTML = entries
    .map(
      (e, i) => `
    <button type="button" class="recent-chip" data-idx="${i}">
      <div class="recent-chip-title">${escapeHtml(e.name || '未命名')}</div>
      <div class="recent-chip-sub">${escapeHtml(
        e.brand ? `${e.brand} · ${CATEGORIES[e.category]?.label || e.category}` : CATEGORIES[e.category]?.label || e.category || ''
      )}</div>
    </button>`
    )
    .join('');
  strip.querySelectorAll('.recent-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-idx'), 10);
      applyPresetFromRecent(MANUAL_RECENT[i]);
    });
  });
}

async function applyPresetFromRecent(entry) {
  if (!entry) return;
  document.getElementById('f-barcode').value = entry.barcode || '';
  document.getElementById('f-name').value = entry.name || '';
  document.getElementById('f-brand').value = entry.brand || '';
  document.getElementById('f-qty').value = entry.quantity != null ? entry.quantity : 1;
  document.getElementById('f-unit').value = entry.unit || '个';
  document.getElementById('f-category').value = entry.category || 'other';
  if (entry.location) document.getElementById('f-location').value = entry.location;
  document.getElementById('f-expiry').value = entry.expiry_date || '';
  document.getElementById('f-price').value = entry.unit_price != null && entry.unit_price !== '' ? entry.unit_price : '';
  setSourcePicker('f', sourcesFromEntry(entry));
  const fi = document.getElementById('f-icon');
  if (fi) fi.value = entry.icon || '';
  const fp = document.getElementById('f-priority');
  if (fp) fp.value = entry.priority || '';
  const ff = document.getElementById('f-frequent-restock');
  if (ff) ff.checked = !!entry.frequent_restock;
  const fr = document.getElementById('f-restock-needed');
  if (fr) fr.checked = !!entry.restock_needed;
  const fn = document.getElementById('f-notes');
  if (fn) fn.value = entry.notes || '';
  onCategoryChange();
  if (
    (entry.category === 'ready_to_feed' || entry.category === 'water_milk') &&
    (entry.ready_to_feed_spec || entry.water_milk_spec)
  ) {
    const ws = entry.ready_to_feed_spec || entry.water_milk_spec;
    const st = document.getElementById('f-wm-stage');
    if (st) st.value = ws.stage === 2 ? '2' : '1';
    const fo = document.getElementById('f-wm-format');
    if (fo) fo.value = ws.bottle_format === 'large_32oz' ? 'large_32oz' : 'small_2oz';
    const gr = document.getElementById('f-wm-grams');
    if (gr) gr.value = ws.grams_per_bottle != null ? ws.grams_per_bottle : '';
    const bp = document.getElementById('f-wm-bpc');
    if (bp) bp.value = ws.bottles_per_case != null ? ws.bottles_per_case : '';
  }
  if (entry.category === 'diaper') {
    await refreshDiaperSegmentOptions();
    if (entry.diaper_spec) {
      const ds = entry.diaper_spec;
      document.getElementById('f-diaper-wmin').value =
        ds.weight_min_kg != null ? ds.weight_min_kg : '';
      document.getElementById('f-diaper-wmax').value =
        ds.weight_max_kg != null ? ds.weight_max_kg : '';
      document.getElementById('f-diaper-ppb').value =
        ds.pieces_per_box != null ? ds.pieces_per_box : '';
      if (ds.sales_unit) {
        const su = document.getElementById('f-diaper-sales-unit');
        if (su) su.value = ds.sales_unit;
      }
      const seg = document.getElementById('f-diaper-segment');
      if (seg && ds.segment_code) {
        seg.value = ds.segment_code;
        onDiaperSegmentPick();
      }
    }
  }
  const pt = document.getElementById('manual-preview-text');
  if (pt) pt.textContent = `预选：${entry.name || '未命名'} · 请核对后点击确认入库`;
  document.getElementById('manual-preview-banner')?.classList.add('show');
  showResultCard();
}

function clearPresetPreview() {
  document.getElementById('manual-preview-banner')?.classList.remove('show');
}

async function refreshDiaperSegmentOptions() {
  const sel = document.getElementById('f-diaper-segment');
  if (!sel) return;
  const brand = (document.getElementById('f-brand').value || '').trim();
  const url =
    '/api/diaper-segments' + (brand ? `?brand=${encodeURIComponent(brand)}` : '');
  try {
    const r = await fetch(url);
    const d = await r.json();
    const globalSegs = d.global_segments || d.segments || [];
    const brandSegs = d.brand_segments || [];
    let html = '<option value="">— 选择模板 —</option>';
    if (brandSegs.length) {
      html +=
        '<optgroup label="当前品牌">' +
        brandSegs
          .map(
            (s) =>
              `<option value="${s.code}" data-min="${s.weight_min_kg}" data-max="${s.weight_max_kg}">${s.label} (${s.weight_min_kg}–${s.weight_max_kg}kg)</option>`
          )
          .join('') +
        '</optgroup>';
    }
    html +=
      '<optgroup label="通用模板">' +
      globalSegs
        .map(
          (s) =>
            `<option value="${s.code}" data-min="${s.weight_min_kg}" data-max="${s.weight_max_kg}">${s.label} (${s.weight_min_kg}–${s.weight_max_kg}kg)</option>`
        )
        .join('') +
      '</optgroup>';
    sel.innerHTML = html;
  } catch (e) {
    sel.innerHTML = '<option value="">— 选择模板 —</option>';
  }
}

function onDiaperSegmentPick() {
  const sel = document.getElementById('f-diaper-segment');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const min = opt.getAttribute('data-min');
  const max = opt.getAttribute('data-max');
  if (min !== null && min !== '') document.getElementById('f-diaper-wmin').value = min;
  if (max !== null && max !== '') document.getElementById('f-diaper-wmax').value = max;
}

async function submitImportTier(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  const fb =
    (document.getElementById('import-tier-brand').value || '').trim() ||
    (document.getElementById('f-brand').value || '').trim();
  const code = (document.getElementById('import-tier-code').value || '').trim();
  const label = (document.getElementById('import-tier-label').value || '').trim();
  const wmin = parseFloat(document.getElementById('import-tier-wmin').value);
  const wmax = parseFloat(document.getElementById('import-tier-wmax').value);
  if (!fb) {
    showToast('请填写品牌');
    return;
  }
  if (!code) {
    showToast('请填写段位代码');
    return;
  }
  if (!Number.isFinite(wmin) || !Number.isFinite(wmax)) {
    showToast('请填写有效的体重上下限 (kg)');
    return;
  }
  try {
    const r = await fetch('/api/diaper-brand-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: fb,
        segment_code: code,
        segment_label: label || code,
        weight_min_kg: wmin,
        weight_max_kg: wmax,
      }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast('❌ ' + (d.error || '保存失败'));
      return;
    }
    document.getElementById('f-brand').value = fb;
    await refreshDiaperSegmentOptions();
    const seg = document.getElementById('f-diaper-segment');
    if (seg) {
      seg.value = code;
      onDiaperSegmentPick();
    }
    showToast('✓ 已保存该品牌段位');
  } catch (err) {
    showToast('❌ ' + err.message);
  }
}

async function loadCategories() {
  try {
    const r = await fetch('/api/categories');
    const d = await r.json();
    Object.assign(CATEGORIES, d);
  } catch (e) {}
}

async function loadLocations() {
  try {
    const r = await fetch('/api/locations');
    const d = await r.json();
    Object.assign(LOCATIONS, d);
  } catch (e) {}
}

function renderCategoryOptions() {
  const entries = Object.entries(CATEGORIES);
  const groups = {};
  entries.forEach(([k, v]) => {
    const parent = v.parent_label || '📦 其他';
    if (!groups[parent]) groups[parent] = [];
    groups[parent].push([k, v]);
  });
  
  const parentOrder = Object.keys(groups).sort((pa, pb) => {
    const sumA = groups[pa].reduce((sum, [k]) => sum + (CATEGORY_STATS[k] || 0), 0);
    const sumB = groups[pb].reduce((sum, [k]) => sum + (CATEGORY_STATS[k] || 0), 0);
    return sumB - sumA;
  });

  return parentOrder.map(parent => {
    const children = groups[parent];
    children.sort((a, b) => {
      const ca = CATEGORY_STATS[a[0]] || 0;
      const cb = CATEGORY_STATS[b[0]] || 0;
      if (cb !== ca) return cb - ca;
      return (a[1].label || '').localeCompare(b[1].label || '', 'zh-CN');
    });
    const opts = children.map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    // Only wrap in optgroup if there's a valid parent name (which we force above)
    return `<optgroup label="${parent}">${opts}</optgroup>`;
  }).join('');
}

function populateCategorySelect() {
  const sel = document.getElementById('f-category');
  if (sel) sel.innerHTML = renderCategoryOptions();
}

function populateLocationSelect() {
  const sel = document.getElementById('f-location');
  sel.innerHTML = Object.entries(LOCATIONS)
    .map(([k, v]) => `<option value="${k}">${v.icon} ${k}</option>`)
    .join('');
}

async function refreshInventory() {
  const active = document.querySelector('.tab-item.active');
    const curTab = active ? active.id.replace('tab-', '') : '';
  if (curTab === 'transit') {
    refreshTransitData();
    return;
  }
  if (curTab === 'carcare') {
    refreshCarCareFrames();
    return;
  }
  try {
    const [items, restock] = await Promise.all([
      fetchJson('/api/items?status=in_stock'),
      fetchJson('/api/restock'),
    ]);
    allItems = items;
    restockItems = restock;
    updateStats();
    renderInventory();
    updateHeaderSubtitle();
    updateRestockBadge();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    showToast(msg);
    document.getElementById('inventory-list').innerHTML =
      `<div class="loading" style="color:var(--danger)">加载失败：${escapeHtml(msg)}</div>`;
  }
}

function updateRestockBadge() {
  const badge = document.getElementById('restock-badge');
  if (restockItems.length > 0) {
    badge.textContent = restockItems.length;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function updateHeaderSubtitle() {
  const sub = document.getElementById('header-subtitle');
  if (!sub) return;
  const active = document.querySelector('.tab-item.active');
  const tabId = active ? active.id : '';
  const tab = tabId.replace('tab-', '');
  if (tab === 'inventory') {
    const th = urgentDaysClient();
    const urgent = allItems.filter((i) => i.days_left <= th).length;
    const ui = (familyPrefs && familyPrefs.ui) || {};
    const mode = ui.inventory_subtitle_mode || 'default';
    if (urgent > 0) {
      const uTpl =
        (ui.inventory_subtitle_urgent_template && String(ui.inventory_subtitle_urgent_template).trim()) ||
        '⚠️ {urgent} 件即将过期';
      sub.textContent = uTpl.replace(/\{urgent\}/g, String(urgent));
      sub.style.color = 'var(--danger)';
    } else if (mode === 'template') {
      const tpl =
        (ui.inventory_subtitle_template && String(ui.inventory_subtitle_template).trim()) ||
        '共 {count} 条 · 食品/衣物/杂物/位置';
      sub.textContent = tpl.replace(/\{count\}/g, String(allItems.length));
      sub.style.color = '';
    } else if (mode === 'llm') {
      if (cachedLlmSubtitle && cachedLlmKey === inventorySubtitleCacheKey()) {
        sub.textContent = cachedLlmSubtitle;
        sub.style.color = '';
      } else {
        sub.textContent = `共 ${allItems.length} 条 · 正在生成…`;
        sub.style.color = '';
        void maybeRefreshLlmSubtitle();
      }
    } else {
      sub.textContent = `共 ${allItems.length} 条 · 食品/衣物/杂物/位置`;
      sub.style.color = '';
    }
  } else if (tab === 'restock') {
    sub.textContent = '按渠道与预测补货';
    sub.style.color = '';
  } else if (tab === 'transit') {
    sub.textContent = '国内运单 · 集运订单（对齐 Notion）';
    sub.style.color = '';
  } else if (tab === 'cooking') {
    sub.textContent = '食材 · 菜 · 每一餐';
    sub.style.color = '';
  } else if (tab === 'calendar') {
    sub.textContent = '入库 · 宝宝 · 三餐';
    sub.style.color = '';
  } else if (tab === 'carcare') {
    sub.textContent = '保养项目 · 间隔 · 下次提醒';
    sub.style.color = '';
  } else if (tab === 'settings') {
    sub.textContent = '家庭与多宝宝';
    sub.style.color = '';
  } else if (tab === 'baby') {
    sub.textContent = '今日记录与统计';
    sub.style.color = '';
  } else {
    sub.textContent = '';
  }
}

function updateStats() {
  const uTh = urgentDaysClient();
  const wTh = warningDaysClient();
  document.getElementById('stat-total').textContent = allItems.length;
  document.getElementById('stat-urgent').textContent = allItems.filter((i) => i.days_left <= uTh).length;
  document.getElementById('stat-warning').textContent = allItems.filter(
    (i) => i.days_left > uTh && i.days_left <= wTh
  ).length;
}

// ─── 右上角 + 入库菜单 ───────────────────────────────────────────────────────

function closeAddEntryMenu() {
  const m = document.getElementById('add-entry-menu');
  if (m) m.style.display = 'none';
  document.removeEventListener('click', closeAddEntryMenuOutside);
}

function closeAddEntryMenuOutside() {
  closeAddEntryMenu();
}

function toggleAddEntryMenu(e) {
  e.stopPropagation();
  const m = document.getElementById('add-entry-menu');
  if (!m) return;
  const open = m.style.display === 'block';
  if (open) {
    m.style.display = 'none';
    document.removeEventListener('click', closeAddEntryMenuOutside);
  } else {
    m.style.display = 'block';
    setTimeout(() => document.addEventListener('click', closeAddEntryMenuOutside), 0);
  }
}

async function openAddManual() {
  closeAddEntryMenu();
  const card = document.getElementById('result-card');
  if (card) {
    card.style.display = 'block';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  await loadManualImportRecent();
  renderRecentImportChips();
  await loadPurchaseChannels();
}

function openAddScan() {
  closeAddEntryMenu();
  startScan();
}

function openAddPhoto() {
  closeAddEntryMenu();
  triggerPhoto();
}

function updateHeaderAddVisibility() {
  const active = document.querySelector('.tab-item.active');
  const tabId = active ? active.id : '';
  const tab = tabId.replace('tab-', '');
  const btn = document.getElementById('header-add-btn');
  if (!btn) return;
  const show = tab === 'inventory';
  btn.style.display = show ? 'flex' : 'none';
  if (!show) {
    closeAddEntryMenu();
    const rc = document.getElementById('result-card');
    if (rc) rc.style.display = 'none';
  }
}

// ─── 转运（国内运单 ↔ 集运订单，对齐 Notion 海淘入库 / 海运批次） ───────────────

function switchTransitEntityPanel(i) {
  const idx = i === 1 ? 1 : 0;
  transitPanelIndex = idx;
  const seg0 = document.getElementById('transit-seg-0');
  const seg1 = document.getElementById('transit-seg-1');
  if (seg0) seg0.classList.toggle('active', idx === 0);
  if (seg1) seg1.classList.toggle('active', idx === 1);
  const p0 = document.getElementById('transit-panel-parcels');
  const p1 = document.getElementById('transit-panel-cos');
  if (p0) p0.style.display = idx === 0 ? 'block' : 'none';
  if (p1) p1.style.display = idx === 1 ? 'block' : 'none';
}

function populateTransitPlatformSelect() {
  const sel = document.getElementById('tp-platform');
  if (!sel || !transitData) return;
  const pl = transitData.platforms || [];
  const cur = sel.value;
  sel.innerHTML =
    '<option value="">— 未选 —</option>' +
    pl.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function populateTransitCoSelect() {
  const sel = document.getElementById('tp-co');
  if (!sel || !transitData) return;
  const orders = [...(transitData.consolidation_orders || [])].sort((a, b) => {
    const da = a.eta || '';
    const db = b.eta || '';
    return db.localeCompare(da);
  });
  const cur = sel.value;
  sel.innerHTML =
    '<option value="">— 未关联 —</option>' +
    orders
      .map(
        (o) =>
          `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}${o.eta ? ' · ' + escapeHtml(o.eta) : ''}</option>`
      )
      .join('');
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function renderTransitParcelList() {
  const el = document.getElementById('transit-parcel-list');
  if (!el || !transitData) return;
  const parcels = transitData.domestic_parcels || [];
  const dup = new Set();
  const trackCount = {};
  for (const p of parcels) {
    const t = (p.domestic_tracking || '').trim();
    if (!t) continue;
    trackCount[t] = (trackCount[t] || 0) + 1;
  }
  for (const k of Object.keys(trackCount)) if (trackCount[k] > 1) dup.add(k);
  const coById = Object.fromEntries((transitData.consolidation_orders || []).map((c) => [c.id, c]));
  if (!parcels.length) {
    el.innerHTML = '<div class="card" style="padding:14px;color:var(--subtext)">暂无国内运单</div>';
    return;
  }
  el.innerHTML = parcels
    .map((p) => {
      const t = (p.domestic_tracking || '').trim();
      const dupBadge = t && dup.has(t) ? '<span class="transit-badge">重复单号</span>' : '';
      const coName =
        p.consolidation_id && coById[p.consolidation_id]
          ? escapeHtml(coById[p.consolidation_id].name)
          : '—';
      const wid = escapeHtml(p.id);
      return `<div class="card" style="padding:0;margin-bottom:10px;overflow:hidden">
  <div class="transit-item-row">
    <div><strong>${escapeHtml(p.product_title)}</strong>${dupBadge}</div>
    <div class="meta">快递单号：${escapeHtml(p.domestic_tracking || '—')} · 上车：${escapeHtml(p.boarded_at || '—')} · 平台：${escapeHtml(p.platform || '—')} · 重量：${p.weight_kg != null ? escapeHtml(String(p.weight_kg)) : '—'} kg</div>
    <div class="meta">海运批次：${coName}</div>
    <div class="transit-item-actions">
      <button type="button" class="big-btn btn-ghost btn-sm" onclick="editTransitParcel('${wid}')">编辑</button>
      <button type="button" class="big-btn btn-ghost btn-sm" onclick="deleteTransitParcel('${wid}')">删除</button>
    </div>
  </div>
</div>`;
    })
    .join('');
}

function renderTransitCoList() {
  const el = document.getElementById('transit-co-list');
  if (!el || !transitData) return;
  const orders = [...(transitData.consolidation_orders || [])].sort((a, b) => {
    const da = a.eta || '';
    const db = b.eta || '';
    return db.localeCompare(da);
  });
  const nParcel = (pid) =>
    (transitData.domestic_parcels || []).filter((x) => x.consolidation_id === pid).length;
  if (!orders.length) {
    el.innerHTML = '<div class="card" style="padding:14px;color:var(--subtext)">暂无集运订单</div>';
    return;
  }
  el.innerHTML = orders
    .map((o) => {
      const wid = escapeHtml(o.id);
      return `<div class="card" style="padding:0;margin-bottom:10px;overflow:hidden">
  <div class="transit-item-row">
    <div><strong>${escapeHtml(o.name)}</strong>${o.picked_up ? ' <span class="transit-badge" style="background:rgba(52,199,89,.15);color:var(--success)">已取到</span>' : ''}</div>
    <div class="meta">ETA：${escapeHtml(o.eta || '—')} · 美国运单：${escapeHtml(o.us_tracking || '—')} · 总重：${o.total_weight_kg != null ? escapeHtml(String(o.total_weight_kg)) : '—'} kg · 运费：${o.shipping_fee_cny != null ? escapeHtml(String(o.shipping_fee_cny)) : '—'} 元</div>
    <div class="meta">关联国内运单：${nParcel(o.id)} 条</div>
    <div class="transit-item-actions">
      <button type="button" class="big-btn btn-ghost btn-sm" onclick="editTransitCo('${wid}')">编辑</button>
      <button type="button" class="big-btn btn-ghost btn-sm" onclick="deleteTransitCo('${wid}')">删除</button>
    </div>
  </div>
</div>`;
    })
    .join('');
}

async function loadTransitData() {
  try {
    transitData = await fetchJson('/api/transit');
    populateTransitPlatformSelect();
    populateTransitCoSelect();
    renderTransitParcelList();
    renderTransitCoList();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    showToast(msg);
    const el = document.getElementById('transit-parcel-list');
    if (el) el.innerHTML = `<div class="card" style="padding:14px;color:var(--danger)">加载失败：${escapeHtml(msg)}</div>`;
    const el2 = document.getElementById('transit-co-list');
    if (el2) el2.innerHTML = '';
  }
}

async function refreshTransitData() {
  await loadTransitData();
  showToast('已刷新转运数据');
}

function resetTransitParcelForm() {
  document.getElementById('tp-edit-id').value = '';
  document.getElementById('tp-product').value = '';
  document.getElementById('tp-tracking').value = '';
  document.getElementById('tp-boarded').value = '';
  document.getElementById('tp-weight').value = '';
  const co = document.getElementById('tp-co');
  if (co) co.value = '';
  const pl = document.getElementById('tp-platform');
  if (pl) pl.value = '';
}

function editTransitParcel(id) {
  const p = (transitData && transitData.domestic_parcels || []).find((x) => x.id === id);
  if (!p) return;
  document.getElementById('tp-edit-id').value = p.id;
  document.getElementById('tp-product').value = p.product_title || '';
  document.getElementById('tp-tracking').value = p.domestic_tracking || '';
  document.getElementById('tp-boarded').value = p.boarded_at || '';
  document.getElementById('tp-weight').value = p.weight_kg != null ? p.weight_kg : '';
  populateTransitPlatformSelect();
  populateTransitCoSelect();
  const plSel = document.getElementById('tp-platform');
  if (p.platform && plSel && ![...plSel.options].some((o) => o.value === p.platform)) {
    plSel.insertAdjacentHTML(
      'beforeend',
      `<option value="${escapeHtml(p.platform)}">${escapeHtml(p.platform)}</option>`
    );
  }
  if (plSel) plSel.value = p.platform || '';
  document.getElementById('tp-co').value = p.consolidation_id || '';
  switchTransitEntityPanel(0);
  document.getElementById('tp-product').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function deleteTransitParcel(id) {
  if (!confirm('删除该国内运单？')) return;
  try {
    const r = await fetch('/api/transit/parcel/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '删除失败');
      return;
    }
    showToast('已删除');
    await loadTransitData();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function submitTransitParcel() {
  const id = document.getElementById('tp-edit-id').value.trim();
  const body = {
    product_title: document.getElementById('tp-product').value,
    domestic_tracking: document.getElementById('tp-tracking').value,
    boarded_at: document.getElementById('tp-boarded').value,
    consolidation_id: document.getElementById('tp-co').value || null,
    platform: document.getElementById('tp-platform').value,
    weight_kg: document.getElementById('tp-weight').value,
  };
  try {
    const url = id
      ? '/api/transit/parcel/' + encodeURIComponent(id)
      : '/api/transit/parcel';
    const method = id ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '保存失败');
      return;
    }
    showToast('已保存');
    resetTransitParcelForm();
    await loadTransitData();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

function resetTransitCoForm() {
  document.getElementById('tc-edit-id').value = '';
  document.getElementById('tc-name').value = '';
  document.getElementById('tc-eta').value = '';
  document.getElementById('tc-fee').value = '';
  document.getElementById('tc-us').value = '';
  document.getElementById('tc-total-weight').value = '';
  document.getElementById('tc-picked').checked = false;
}

function editTransitCo(id) {
  const o = (transitData && transitData.consolidation_orders || []).find((x) => x.id === id);
  if (!o) return;
  document.getElementById('tc-edit-id').value = o.id;
  document.getElementById('tc-name').value = o.name || '';
  const eta = o.eta ? String(o.eta).slice(0, 10) : '';
  document.getElementById('tc-eta').value = eta;
  document.getElementById('tc-fee').value = o.shipping_fee_cny != null ? o.shipping_fee_cny : '';
  document.getElementById('tc-us').value = o.us_tracking || '';
  document.getElementById('tc-total-weight').value = o.total_weight_kg != null ? o.total_weight_kg : '';
  document.getElementById('tc-picked').checked = !!o.picked_up;
  switchTransitEntityPanel(1);
  document.getElementById('tc-name').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function deleteTransitCo(id) {
  if (!confirm('删除该集运订单？关联的国内运单将解除与批次的关联。')) return;
  try {
    const r = await fetch('/api/transit/consolidation/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '删除失败');
      return;
    }
    showToast('已删除');
    resetTransitCoForm();
    await loadTransitData();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

async function submitTransitConsolidation() {
  const id = document.getElementById('tc-edit-id').value.trim();
  const body = {
    name: document.getElementById('tc-name').value,
    eta: document.getElementById('tc-eta').value || null,
    picked_up: document.getElementById('tc-picked').checked,
    total_weight_kg: document.getElementById('tc-total-weight').value,
    us_tracking: document.getElementById('tc-us').value,
    shipping_fee_cny: document.getElementById('tc-fee').value,
  };
  try {
    const url = id
      ? '/api/transit/consolidation/' + encodeURIComponent(id)
      : '/api/transit/consolidation';
    const method = id ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '保存失败');
      return;
    }
    showToast('已保存');
    resetTransitCoForm();
    await loadTransitData();
  } catch (e) {
    showToast(e.message || String(e));
  }
}

function carcareDaysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso + 'T12:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  t.setHours(0, 0, 0, 0);
  return Math.round((t - now) / 86400000);
}

function carcareDueLabel(days) {
  if (days === null) return '';
  if (days < 0) return `已超 ${-days} 天`;
  if (days === 0) return '今天';
  return `还有 ${days} 天`;
}

function carcareDueClassForDate(nextDate) {
  const d = carcareDaysUntil(nextDate);
  if (d === null) return '';
  if (d < 0) return 'overdue';
  if (d <= 14) return 'soon';
  return '';
}

function formatCarInterval(s) {
  const p = [];
  if (s.interval_months != null && Number.isFinite(s.interval_months)) p.push(`每 ${s.interval_months} 个月`);
  if (s.interval_km != null && Number.isFinite(s.interval_km)) p.push(`每 ${s.interval_km} km`);
  return p.length ? p.join(' · ') : '—';
}

function addMonthsIso(iso, months) {
  if (!iso || months == null || !Number.isFinite(months)) return null;
  const d = new Date(iso + 'T12:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function markCarServiceDone(vehicleId, scheduleId) {
  const kmStr = window.prompt('当前里程（km，可留空）', '');
  if (kmStr === null) return;
  const km = kmStr.trim() ? parseFloat(kmStr) : null;
  let doc;
  try {
    doc = await fetchJson('/api/cars');
  } catch (e) {
    showToast(e.message || '加载失败');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const vehicles = (doc.vehicles || []).map((v) => {
    if (v.id !== vehicleId) return v;
    const schedule = (v.schedule || []).map((s) => {
      if (s.id !== scheduleId) return s;
      let next_date = s.next_date;
      let next_km = s.next_km;
      if (s.interval_months != null && Number.isFinite(s.interval_months)) {
        const nd = addMonthsIso(today, s.interval_months);
        if (nd) next_date = nd;
      }
      if (s.interval_km != null && Number.isFinite(s.interval_km) && km != null && Number.isFinite(km)) {
        next_km = Math.round(km + s.interval_km);
      }
      return {
        ...s,
        last_date: today,
        last_km: km != null && Number.isFinite(km) ? km : s.last_km,
        next_date,
        next_km,
      };
    });
    return { ...v, schedule };
  });
  try {
    await fetchJson('/api/cars', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: doc.version || '1.0', vehicles }),
    });
    await loadFamilyPrefs();
    loadCarCareUI();
    showToast('已记录本次保养');
  } catch (e) {
    showToast(e.message || '保存失败');
  }
}

function loadCarCareUI() {
  const body = document.getElementById('carcare-body');
  if (!body) return;
  const cars = (familyPrefs && familyPrefs.family && familyPrefs.family.cars) || [];
  if (!cars.length) {
    body.innerHTML =
      '<div class="empty">暂无车辆。请在 <code style="font-size:12px">config/cars.json</code> 添加，或在「设置」里添加后保存。</div>';
    return;
  }
  body.innerHTML = cars
    .map((c) => {
      const title = escapeHtml(c.name || '未命名');
      const plate = c.plate ? `<span class="carcare-plate">${escapeHtml(c.plate)}</span>` : '';
      const rows = (c.schedule || [])
        .map((s) => {
          const nd = s.next_date;
          const dcls = carcareDueClassForDate(nd);
          const hint = carcareDueLabel(carcareDaysUntil(nd));
          const nextKm = s.next_km != null && Number.isFinite(s.next_km) ? `${Math.round(s.next_km)} km` : '—';
          const lastPart = [s.last_date || '—', s.last_km != null && Number.isFinite(s.last_km) ? `${Math.round(s.last_km)} km` : ''].filter(Boolean).join(' · ');
          const vid = JSON.stringify(c.id);
          const sid = JSON.stringify(s.id);
          return `<tr>
          <td><strong>${escapeHtml(s.name || '项目')}</strong>${s.note ? `<div style="font-size:11px;color:var(--subtext);margin-top:4px">${escapeHtml(s.note)}</div>` : ''}</td>
          <td>${escapeHtml(formatCarInterval(s))}</td>
          <td>${escapeHtml(lastPart)}</td>
          <td><span class="carcare-due ${dcls}">${nd ? escapeHtml(nd) : '—'}${hint ? ` <span style="font-size:11px;font-weight:400">(${escapeHtml(hint)})</span>` : ''}</td>
          <td>${escapeHtml(nextKm)}</td>
          <td><button type="button" class="source-add-btn" onclick="markCarServiceDone(${vid}, ${sid})">本次已做</button></td>
        </tr>`;
        })
        .join('');
      const table = rows
        ? `<table class="carcare-table">
        <thead><tr><th>项目</th><th>建议间隔</th><th>上次</th><th>下次（日期）</th><th>下次（里程）</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
        : '<p style="font-size:13px;color:var(--subtext);margin-top:8px">暂无保养项。可直接编辑 config/cars.json 的 schedule 数组。</p>';
      return `<div class="card carcare-car-card" style="margin-bottom:12px">
      <div class="card-title">${title}${plate}</div>
      ${table}
    </div>`;
    })
    .join('');
}

function refreshCarCareFrames() {
  loadCarCareUI();
  showToast('已刷新养车');
}

// ─── 养车：CSV 导入 ────────────────────────────────────────────────────────────

let carImportPreviewData = null;

function openCarImport() {
  const sheet = document.getElementById('carcare-import-sheet');
  if (!sheet) return;
  // 填充车辆选项
  const sel = document.getElementById('ci-vehicle');
  const cars = (familyPrefs && familyPrefs.family && familyPrefs.family.cars) || [];
  sel.innerHTML = cars.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</option>`).join('');
  // 重置
  document.getElementById('ci-file').value = '';
  document.getElementById('ci-preview').style.display = 'none';
  document.getElementById('ci-status').textContent = '';
  carImportPreviewData = null;
  sheet.style.display = 'block';
}

function closeCarImport() {
  const sheet = document.getElementById('carcare-import-sheet');
  if (sheet) sheet.style.display = 'none';
}

async function onCarImportFile() {
  const file = document.getElementById('ci-file').files[0];
  if (!file) return;
  const status = document.getElementById('ci-status');
  status.textContent = '解析中…';
  document.getElementById('ci-preview').style.display = 'none';
  carImportPreviewData = null;
  let content;
  try {
    content = await file.text();
  } catch (e) {
    status.textContent = '读取文件失败：' + e.message;
    return;
  }
  const vehicleId = document.getElementById('ci-vehicle').value;
  try {
    const result = await fetchJson('/api/cars/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicle_id: vehicleId, content }),
    });
    carImportPreviewData = result;
    status.textContent = '';
    document.getElementById('ci-summary').textContent =
      `共解析 ${result.total} 条记录，其中 ${result.matched} 条匹配到现有保养项，${result.total - result.matched} 条将新建项目。`;
    document.getElementById('ci-records').innerHTML = (result.records || []).map((r) => {
      const matchTag = r.matched_schedule_id
        ? `<span style="color:var(--success,#34c759);font-weight:600">✓ 已匹配</span>`
        : `<span style="color:var(--warning,#ff9500)">+ 新建</span>`;
      const parts = [r.date, r.km != null ? r.km + ' km' : null, r.service_type || null].filter(Boolean);
      return `<div style="border-bottom:0.5px solid var(--border);padding:4px 0">${matchTag} ${escapeHtml(parts.join(' · '))}${r.cost != null ? ` · $${r.cost}` : ''}</div>`;
    }).join('');
    document.getElementById('ci-preview').style.display = 'block';
  } catch (e) {
    status.textContent = '预览失败：' + (e.message || '未知错误');
  }
}

async function applyCarImport() {
  if (!carImportPreviewData) return;
  const vehicleId = document.getElementById('ci-vehicle').value;
  const status = document.getElementById('ci-status');
  status.textContent = '保存中…';
  try {
    const result = await fetchJson('/api/cars/import/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicle_id: vehicleId, records: carImportPreviewData.records }),
    });
    closeCarImport();
    await loadFamilyPrefs();
    loadCarCareUI();
    showToast(`导入完成：更新 ${result.updated} 项，新建 ${result.created} 项`);
  } catch (e) {
    status.textContent = '导入失败：' + (e.message || '未知错误');
  }
}

// ─── Tab 切换 ─────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab-item').forEach((t) => t.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  updateHeaderAddVisibility();
  updateHeaderSubtitle();
  if (tab === 'inventory') {
    renderInventory();
    setupBtcpDragDrop();
  }
  if (tab === 'restock') renderRestock();
  if (tab === 'transit') {
    switchTransitEntityPanel(transitPanelIndex);
    loadTransitData();
  }
  if (tab === 'carcare') {
    loadFamilyPrefs().then(() => loadCarCareUI());
  }
  if (tab === 'baby') {
    loadBabyStats();
    loadBabyTimeline();
  }
  if (tab === 'cooking') loadCookingUI();
  if (tab === 'calendar') loadCalendarMonth();
  if (tab === 'settings') loadSettingsUI();
}

// ─── 扫码功能 ─────────────────────────────────────────────────────────────────

function startScan() {
  stopScan();
  document.getElementById('scan-card').style.display = 'block';
  resetForm();

  scanner = new Html5Qrcode('scanner-container');
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.5 },
    async (code) => {
      stopScan();
      await lookupBarcode(code);
    },
    () => {}
  ).catch(err => {
    showToast('无法访问相机：' + err);
    document.getElementById('scan-card').style.display = 'none';
  });
}

function stopScan() {
  if (scanner) {
    scanner.stop().catch(() => {});
    scanner = null;
  }
  document.getElementById('scan-card').style.display = 'none';
}

async function lookupBarcode(code) {
  showToast('查询条码 ' + code + '...');
  document.getElementById('f-barcode').value = code;

  try {
    const r = await fetch('/api/barcode/' + encodeURIComponent(code));
    const d = await r.json();

    if (d.found) {
      fillForm({
        name: d.name,
        brand: d.brand,
        category: d.category,
        location: d.location,
        expiry_date: d.expiry_date,
        image_url: d.image_url,
      });
      showToast('✓ 找到商品：' + d.name);
    } else {
      showToast('条码未收录，请手动填写');
      showResultCard();
    }
  } catch (e) {
    showToast('查询失败：' + e.message);
    showResultCard();
  }
}

// ─── 拍照功能 ─────────────────────────────────────────────────────────────────

function triggerPhoto() {
  stopScan();
  resetForm();
  document.getElementById('photo-input').click();
}

async function handlePhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  // 显示预览
  const preview = document.getElementById('photo-preview');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';

  // 显示加载
  document.getElementById('analyzing-loading').style.display = 'block';
  resetForm(false);

  const formData = new FormData();
  formData.append('image', file);

  try {
    const r = await fetch('/api/analyze-image', { method: 'POST', body: formData });
    const d = await r.json();

    document.getElementById('analyzing-loading').style.display = 'none';

    if (d.error) {
      showToast('❌ ' + d.error);
      showResultCard();
      return;
    }

    fillForm({
      name: d.name,
      brand: d.brand,
      category: d.category,
      location: d.location,
      expiry_date: d.expiry_date,
      confidence: d.confidence,
      expiry_from_default: d.expiry_from_default,
    });

    if (d.expiry_from_default) {
      showToast('ℹ️ 未识别到有效期，已用品类默认值');
    } else {
      showToast('✓ AI 识别完成（置信度：' + (d.confidence || '-') + '）');
    }
  } catch (e) {
    document.getElementById('analyzing-loading').style.display = 'none';
    showToast('识别失败：' + e.message);
    showResultCard();
  }

  // 重置 input 以允许重复选同一文件
  event.target.value = '';
}

// ─── 表单填充 ─────────────────────────────────────────────────────────────────

function fillForm({ name, brand, category, location, expiry_date, image_url, confidence, expiry_from_default }) {
  if (name) document.getElementById('f-name').value = name;
  if (brand) document.getElementById('f-brand').value = brand;
  if (category) document.getElementById('f-category').value = category;
  if (location) document.getElementById('f-location').value = location;
  if (expiry_date) document.getElementById('f-expiry').value = expiry_date;

  // 置信度标签
  const badge = document.getElementById('confidence-badge');
  if (confidence) {
    badge.textContent = { high: '高置信度', medium: '中置信度', low: '低置信度' }[confidence] || confidence;
    badge.className = 'confidence-badge confidence-' + confidence;
  } else {
    badge.textContent = '';
  }

  // 商品名/品牌显示
  const header = document.getElementById('result-header');
  if (name) {
    document.getElementById('result-name-display').textContent = name;
    document.getElementById('result-brand-display').textContent = brand || '';
    header.style.display = 'flex';
  }

  // 商品图片
  const img = document.getElementById('result-img');
  if (image_url) {
    img.src = image_url;
    img.style.display = 'block';
  }

  // 有效期标红提示
  const expiryInput = document.getElementById('f-expiry');
  if (expiry_from_default) {
    expiryInput.style.borderColor = 'var(--warning)';
  }

  onCategoryChange();
  showResultCard();
}

function showResultCard() {
  document.getElementById('result-card').style.display = 'block';
  document.getElementById('result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function onCategoryChange() {
  const cat = document.getElementById('f-category').value;
  if (CATEGORIES[cat]) {
    document.getElementById('f-location').value = CATEGORIES[cat].location;
  }
  const df = document.getElementById('diaper-fields');
  if (df) {
    if (cat === 'diaper') {
      df.classList.add('show');
      document.getElementById('f-unit').value = '片';
      const ib = document.getElementById('import-tier-brand');
      const fb = document.getElementById('f-brand');
      if (ib && fb && !(ib.value || '').trim()) {
        ib.value = fb.value || '';
      }
      refreshDiaperSegmentOptions();
    } else {
      df.classList.remove('show');
    }
  }
  const dsf = document.getElementById('digital-secret-fields');
  if (dsf) {
    dsf.style.display = cat === 'digital_voucher' ? 'block' : 'none';
  }
  const rtf = document.getElementById('ready-to-feed-fields');
  if (rtf) {
    if (cat === 'ready_to_feed' || cat === 'water_milk') {
      rtf.classList.add('show');
      document.getElementById('f-unit').value = '瓶';
    } else {
      rtf.classList.remove('show');
    }
  }
  // unit_spec fields: show if category has unit_spec_template or has existing unit_spec data
  const usf = document.getElementById('unit-spec-fields');
  if (usf && CATEGORIES[cat]) {
    const tmpl = CATEGORIES[cat].unit_spec_template;
    // Show if there is a template OR if we are showing an existing item with unit_spec data (although this is in add mode mainly, but kept for future)
    if (tmpl) {
      usf.style.display = 'block';
      const skuEl = document.getElementById('f-us-sku-unit');
      const spuEl = document.getElementById('f-us-spu-unit');
      if (skuEl && !skuEl.value) skuEl.value = tmpl.sku_unit || '';
      if (spuEl && !spuEl.value) spuEl.value = tmpl.spu_unit || '';
    } else {
      usf.style.display = 'none';
      if (typeof _editingItemId === 'undefined' || !_editingItemId) {
        document.getElementById('f-us-sku-unit').value = '';
        document.getElementById('f-us-spu-unit').value = '';
        document.getElementById('f-us-spu-qty').value = '';
      }
    }
  }
}

function resetForm(hideCard = true) {
  document.getElementById('add-form').reset();
  document.getElementById('f-barcode').value = '';
  document.getElementById('f-qty').value = '1';
  document.getElementById('f-unit').value = '个';
  document.getElementById('f-expiry').style.borderColor = '';
  document.getElementById('confidence-badge').textContent = '';
  document.getElementById('result-header').style.display = 'none';
  document.getElementById('result-img').style.display = 'none';
  document.getElementById('result-img').src = '';
  if (hideCard) {
    document.getElementById('photo-preview').style.display = 'none';
    document.getElementById('photo-preview').src = '';
    document.getElementById('analyzing-loading').style.display = 'none';
  }
  const ds = document.getElementById('f-diaper-segment');
  if (ds) ds.selectedIndex = 0;
  ['f-diaper-wmin', 'f-diaper-wmax', 'f-diaper-ppb'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('diaper-fields')?.classList.remove('show');
  document.getElementById('ready-to-feed-fields')?.classList.remove('show');
  ['f-wm-grams', 'f-wm-bpc'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const wms = document.getElementById('f-wm-stage');
  if (wms) wms.value = '1';
  const wmf = document.getElementById('f-wm-format');
  if (wmf) wmf.value = 'small_2oz';
  const fsec = document.getElementById('f-secret-plaintext');
  if (fsec) fsec.value = '';
  sourcePickerState.f = [];
  renderSourceChips('f');
  onCategoryChange();
}

// 清空手动录入（表单始终可见，仅重置内容）
function resetManualForm() {
  clearPresetPreview();
  resetForm(true);
}

// ─── 提交入库 ─────────────────────────────────────────────────────────────────

async function submitItem(e) {
  e.preventDefault();
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = '入库中...';

  const cat = document.getElementById('f-category').value;
  const bcRaw = (document.getElementById('f-barcode').value || '').trim();
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    brand: document.getElementById('f-brand').value.trim(),
    barcode: bcRaw || null,
    category: cat,
    location: document.getElementById('f-location').value,
    expiry_date: document.getElementById('f-expiry').value,
    quantity: document.getElementById('f-qty').value,
    unit: cat === 'diaper' ? '片' : cat === 'ready_to_feed' || cat === 'water_milk' ? '瓶' : document.getElementById('f-unit').value,
    unit_price: document.getElementById('f-price').value,
    sources: getSourcePicker('f'),
    icon: (document.getElementById('f-icon').value || '').trim(),
    frequent_restock: document.getElementById('f-frequent-restock').checked,
    restock_lead_days: parseInt(document.getElementById('f-restock-lead').value) || 7,
    restock_needed: document.getElementById('f-restock-needed').checked,
    priority: document.getElementById('f-priority').value || null,
    notes: (document.getElementById('f-notes').value || '').trim() || null,
  };

  if (cat === 'digital_voucher') {
    const sp = (document.getElementById('f-secret-plaintext')?.value || '').trim();
    if (sp) payload.secret_plaintext = sp;
  }

  if (cat === 'diaper') {
    const wmin = parseFloat(document.getElementById('f-diaper-wmin').value);
    const wmax = parseFloat(document.getElementById('f-diaper-wmax').value);
    const ppb = parseInt(document.getElementById('f-diaper-ppb').value, 10);
    const seg = document.getElementById('f-diaper-segment');
    const code = seg?.value || '';
    const opt = seg?.options[seg.selectedIndex];
    if (!Number.isFinite(wmin) || !Number.isFinite(wmax)) {
      showToast('请填写尿裤适用的体重范围 (kg)');
      btn.disabled = false;
      btn.textContent = '✓ 确认入库';
      return;
    }
    payload.diaper_spec = {
      segment_code: code || null,
      segment_label: opt?.text?.split(' (')[0]?.trim() || code || null,
      weight_min_kg: wmin,
      weight_max_kg: wmax,
      sales_unit: document.getElementById('f-diaper-sales-unit').value || '箱',
      pieces_per_box: Number.isFinite(ppb) && ppb > 0 ? ppb : null,
      spec_label: `${code || '尿裤'} ${Number.isFinite(ppb) ? ppb + '片/' + (document.getElementById('f-diaper-sales-unit').value || '箱') : ''}`.trim(),
    };
  }

  if (cat === 'ready_to_feed' || cat === 'water_milk') {
    const grams = parseFloat(document.getElementById('f-wm-grams').value);
    const bpc = parseInt(document.getElementById('f-wm-bpc').value, 10);
    const stage = parseInt(document.getElementById('f-wm-stage').value, 10);
    const fmt = document.getElementById('f-wm-format').value;
    if (!Number.isFinite(grams) || grams <= 0) {
      showToast('请填写一瓶多少 g');
      btn.disabled = false;
      btn.textContent = '✓ 确认入库';
      return;
    }
    payload.ready_to_feed_spec = {
      stage: stage === 2 ? 2 : 1,
      grams_per_bottle: grams,
      bottles_per_case: Number.isFinite(bpc) && bpc > 0 ? bpc : null,
      bottle_format: fmt === 'large_32oz' ? 'large_32oz' : 'small_2oz',
    };
  }

  // unit_spec (SKU/SPU)
  const usSkuUnit = (document.getElementById('f-us-sku-unit')?.value || '').trim();
  const usSpuUnit = (document.getElementById('f-us-spu-unit')?.value || '').trim();
  const usSpuQty  = parseInt(document.getElementById('f-us-spu-qty')?.value || '', 10);
  if (usSkuUnit && usSpuUnit) {
    payload.unit_spec = {
      sku_unit: usSkuUnit,
      spu_unit: usSpuUnit,
      spu_qty: Number.isFinite(usSpuQty) && usSpuQty > 0 ? usSpuQty : null,
    };
  }

  try {
    const d = await fetchJson('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (d.success) {
      showToast('✓ ' + d.item.name + ' 已入库！');
      resetManualForm();
      await loadManualImportRecent();
      renderRecentImportChips();
      await refreshInventory();
    } else {
      showToast('❌ ' + (d.error || '入库失败'));
    }
  } catch (err) {
    showToast('❌ ' + (err.message || '网络错误'));
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ 确认入库';
  }
}

// ─── 库存渲染 ─────────────────────────────────────────────────────────────────

function setFilter(filter, el) {
  currentFilter = filter;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderInventory();
}

function diaperBoxHint(item) {
  const ds = item.diaper_spec;
  if (!ds || !ds.pieces_per_box || ds.pieces_per_box <= 0) return '';
  const b = (item.quantity / ds.pieces_per_box).toFixed(2);
  return ` · 约${b}${ds.sales_unit || '箱'}`;
}

function readyToFeedCaseHint(item) {
  const ws = item.ready_to_feed_spec || item.water_milk_spec;
  if (!ws || !ws.bottles_per_case || ws.bottles_per_case <= 0) return '';
  const b = (item.quantity / ws.bottles_per_case).toFixed(2);
  return ` · 约${b}箱`;
}

function spuHint(item) {
  // Prefer spu_info from API (includes backward-compat from diaper_spec/ready_to_feed_spec)
  const si = item.spu_info;
  if (si && si.spu_qty && si.spu_qty > 0) {
    const count = (item.quantity / si.spu_qty).toFixed(2);
    return ` · ≈${count}${si.spu_unit}`;
  }
  // Fallback to old hints if API didn't include spu_info
  return diaperBoxHint(item) || readyToFeedCaseHint(item);
}

function renderInventory() {
  const uTh = urgentDaysClient();
  const wTh = warningDaysClient();
  let items = [...allItems].sort((a, b) => a.days_left - b.days_left);

  if (currentFilter === 'expiring') {
    items = items.filter((i) => i.days_left <= wTh);
  } else if (currentFilter !== 'all') {
    items = items.filter(i => i.location.includes(currentFilter));
  }

  const container = document.getElementById('inventory-list');

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${currentFilter === 'expiring' ? '✅' : '📭'}</div>
        <div class="empty-text">${currentFilter === 'expiring' ? '没有即将过期的物品' : '储物为空'}</div>
        <div class="empty-sub">在上方扫码或拍照入库</div>
      </div>`;
    return;
  }

  // 按位置分组
  const groups = {};
  items.forEach(item => {
    const key = currentFilter !== 'all' && currentFilter !== 'expiring' ? '当前筛选' : item.location;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });

  let html = '';
  for (const [loc, locItems] of Object.entries(groups)) {
    const icon = Object.entries(LOCATIONS).find(([k]) => loc.includes(k))?.[1]?.icon || '📦';
    html += `<div class="section-header">${icon} ${loc}</div>`;
    html += '<div class="card" style="padding:0 16px">';
    locItems.forEach(item => {
      const dot = item.days_left <= uTh ? 'dot-red' : item.days_left <= wTh ? 'dot-yellow' : 'dot-green';
      const expText = item.days_left <= 0 ? '<span style="color:var(--danger)">已过期</span>'
        : item.days_left <= uTh ? `<span style="color:var(--danger)">还剩 ${item.days_left} 天</span>`
        : item.days_left <= wTh ? `<span style="color:var(--warning)">还剩 ${item.days_left} 天</span>`
        : `${item.expiry_date}`;

      const p = item.prediction;
      let predHtml = '';
      if (p && p.mode !== 'none') {
        const rateText = p.mode === 'weekly'
          ? `${p.avg_weekly}${item.unit}/周`
          : `${p.avg_daily}${item.unit}/天`;
        const emptyText = p.days_until_empty != null
          ? (p.days_until_empty < 1 ? '即将耗尽' : `约 ${Math.round(p.days_until_empty)} 天后耗尽`)
          : '';
        const urgencyClass = `pred-${p.restock_urgency}`;
        const urgencyText = {overdue:'🚨 该补了', urgent:'⚠️ 尽快补货', soon:'📦 即将需要补货', normal:'✓'}[p.restock_urgency] || '';
        const srcBaby = p.sources?.baby_log ? '<span class="pred-tag" style="background:#ede7f6;color:#5e35b1">宝宝日志</span> ' : '';
        predHtml = `${srcBaby}<span class="pred-tag ${urgencyClass}">${urgencyText}</span> <span style="font-size:11px;color:var(--subtext)">${rateText} · ${emptyText}</span>`;
      } else if (p && p.mode === 'none') {
        predHtml = `<span class="pred-tag pred-none">暂无预测</span>`;
      }

      let diaperSpecLine = '';
      if (item.diaper_spec) {
        const ds = item.diaper_spec;
        diaperSpecLine = `<div class="inv-diaper-badge">${ds.segment_label || ds.segment_code || '尿裤'} · ${ds.weight_min_kg}–${ds.weight_max_kg}kg${ds.pieces_per_box ? ` · ${ds.pieces_per_box}片/${ds.sales_unit || '箱'}` : ''}</div>`;
      }
      let readyToFeedSpecLine = '';
      if (
        (item.category === 'ready_to_feed' || item.category === 'water_milk') &&
        (item.ready_to_feed_spec || item.water_milk_spec)
      ) {
        const ws = item.ready_to_feed_spec || item.water_milk_spec;
        readyToFeedSpecLine = `<div class="inv-diaper-badge">${ws.stage}段 · ${ws.bottle_format === 'large_32oz' ? '32oz' : '2oz'} · ${ws.grams_per_bottle}g/瓶${ws.bottles_per_case ? ` · ${ws.bottles_per_case}瓶/箱` : ''}</div>`;
      }
      let diaperWeightLine = '';
      if (item.category === 'diaper' && p?.diaper_baby_meta?.has_growth) {
        const m = p.diaper_baby_meta;
        const w = m.weight_for_today_kg ?? m.latest_weight_kg;
        diaperWeightLine = `<div class="inv-diaper-badge">体重 ${w}kg · ${m.in_current_segment ? '✓ 本段位消耗计入' : '⚠️ 当前体重不在本 SKU 区间'}</div>`;
      } else if (item.category === 'diaper' && p?.diaper_baby_meta && !p.diaper_baby_meta.has_growth) {
        diaperWeightLine = `<div class="inv-diaper-badge">暂无生长体重记录，段位预测未启用</div>`;
      }

      const ic = escapeHtml(itemDisplayIcon(item));
      const nm = escapeHtml(item.name);
      const pri = item.priority;
      const priBadge = pri === 'high'
        ? '<span class="inv-badge inv-badge-pri-high">⏫ 高</span>'
        : pri === 'medium'
          ? '<span class="inv-badge inv-badge-pri-med">⏫ 中</span>'
          : pri === 'low'
            ? '<span class="inv-badge inv-badge-pri-low">⏫ 低</span>'
            : '';
      const cartBadge = item.restock_needed ? '<span class="inv-badge inv-badge-cart">🛒 需补货</span>' : '';
      const freqBadge = item.frequent_restock ? '<span class="inv-badge inv-badge-freq">📌 常买</span>' : '';
      const cryptoBadge = item.has_encrypted_secret
        ? '<span class="inv-badge" style="background:rgba(0,122,255,.12);color:var(--primary)">🔐</span>'
        : '';
      const notesPrev = item.notes ? `<div class="inv-notes-preview">${escapeHtml(item.notes)}</div>` : '';
      const srcs = getItemSources(item);
      const srcRow = srcs.length
        ? `<div class="inv-src-row">${srcs.map((s) => `<span class="src-tag">${escapeHtml(s)}</span>`).join('')}</div>`
        : '';

      html += `
        <div class="inv-item" data-inv-id="${item.id}">
          <div class="inv-dot ${dot}"></div>
          <div class="inv-info" onclick="openItemDetail('${item.id}')">
            <div class="inv-name-row">
              <span class="inv-emoji">${ic}</span>
              <div class="inv-name">${nm}</div>
            </div>
            ${srcRow}
            ${cartBadge || priBadge || freqBadge || cryptoBadge ? `<div class="inv-badges">${cartBadge}${priBadge}${freqBadge}${cryptoBadge}</div>` : ''}
            ${diaperSpecLine}
            ${readyToFeedSpecLine}
            ${diaperWeightLine}
            <div class="inv-meta">${item.quantity}${item.unit}${spuHint(item)} · ${item.category_label} · ${expText}</div>
            ${notesPrev}
            ${predHtml ? `<div style="margin-top:4px">${predHtml}</div>` : ''}
          </div>
          <div class="inv-actions">
            <div class="inv-qty-btn" onclick="event.stopPropagation();quickConsume('${item.id}')">−</div>
          </div>
        </div>`;
    });
    html += '</div>';
  }
  container.innerHTML = html;
  bindInventorySwipeHandlers();
}

let _inventorySwipeBound = false;

function bindInventorySwipeHandlers() {
  const container = document.getElementById('inventory-list');
  if (!container || _inventorySwipeBound) return;
  _inventorySwipeBound = true;
  container.addEventListener(
    'touchstart',
    (e) => {
      const el = e.target.closest('.inv-item[data-inv-id]');
      if (!el) return;
      _invSwipe.startX = e.touches[0].clientX;
      _invSwipe.startY = e.touches[0].clientY;
      _invSwipe.id = el.getAttribute('data-inv-id');
    },
    { passive: true }
  );
  container.addEventListener(
    'touchend',
    (e) => {
      if (!_invSwipe.id) return;
      const dx = e.changedTouches[0].clientX - _invSwipe.startX;
      const dy = e.changedTouches[0].clientY - _invSwipe.startY;
      const id = _invSwipe.id;
      _invSwipe.id = null;
      if (Math.abs(dy) > 45) return;
      if (dx > 55) swipeToggleRestockNeeded(id);
    },
    { passive: true }
  );
  container.addEventListener('touchcancel', () => {
    _invSwipe.id = null;
  });
}

async function swipeToggleRestockNeeded(id) {
  const item = allItems.find((i) => i.id === id);
  if (!item) return;
  const next = !item.restock_needed;
  try {
    await fetch(`/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restock_needed: next }),
    });
    showToast(next ? '已加入补货清单' : '已取消需补货');
    await refreshInventory();
    renderInventory();
    if (document.getElementById('page-restock')?.classList.contains('active')) renderRestock();
  } catch (e) {
    showToast('操作失败');
  }
}

async function removePendingIngredient(name) {
  try {
    const r = await fetch(`/api/cooking/pending-ingredient?${new URLSearchParams({ name })}`, {
      method: 'DELETE',
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '移除失败');
      return;
    }
    showToast('已移除');
    await refreshInventory();
    if (document.getElementById('page-restock')?.classList.contains('active')) renderRestock();
  } catch (e) {
    showToast('网络错误');
  }
}

// ─── 补货清单渲染 ─────────────────────────────────────────────────────────────

function renderRestock() {
  const container = document.getElementById('restock-list');
  const filterEl = document.getElementById('restock-channel-filters');

  if (restockItems.length === 0) {
    if (filterEl) filterEl.innerHTML = '';
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✅</div>
        <div class="empty-text">暂无补货需求</div>
        <div class="empty-sub">常买食材与宝宝用品会按消耗预测；其它食材请右滑标记需补货或从做菜推荐加入。</div>
      </div>`;
    return;
  }

  const allCh = getRestockChannelsFromItems();
  if (filterEl) {
    filterEl.innerHTML = allCh
      .map(
        (ch, i) =>
          `<label><input type="checkbox" ${isRestockChannelSelected(ch) ? 'checked' : ''} onchange="onRestockChannelCheck(${i}, this.checked)"> ${escapeHtml(ch)}</label>`
      )
      .join('');
  }

  const visibleChannels = allCh.filter((ch) => isRestockChannelSelected(ch));
  const urgencyOrder = { overdue: 0, urgent: 1, soon: 2 };

  if (visibleChannels.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✋</div>
        <div class="empty-text">没有符合筛选的渠道</div>
        <div class="empty-sub">请勾选上方购买渠道，或点「恢复全部渠道」</div>
      </div>`;
    return;
  }

  let html = '';
  for (const ch of visibleChannels) {
    const itemsInCh = restockItems
      .filter((item) => {
        const srcs = getItemSources(item);
        const keys = srcs.length ? srcs : ['未设置渠道'];
        return keys.includes(ch);
      })
      .sort(
        (a, b) =>
          urgencyOrder[a.prediction.restock_urgency] -
          urgencyOrder[b.prediction.restock_urgency]
      );
    if (itemsInCh.length === 0) continue;

    html += `<div class="section-header">🛒 ${escapeHtml(ch)}</div>`;
    html += '<div class="card" style="padding:0 16px">';
    itemsInCh.forEach((item) => {
      const p = item.prediction;
      if (item.pending_only) {
        html += `
        <div class="restock-item">
          <div class="restock-top">
            <div class="restock-name">${escapeHtml(item.name)}</div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap">
              <span class="pred-tag pred-urgent">做菜待买</span>
              <button type="button" class="source-add-btn" onclick="removePendingIngredient(${JSON.stringify(item.name)})">已买 / 移除</button>
            </div>
          </div>
          <div class="restock-meta" style="color:var(--subtext);font-size:12px">
            尚未入库的食材；买到并入库后可在此移除。
          </div>
        </div>`;
        return;
      }
      const urgency = p.restock_urgency;
      const modeLabel =
        p.mode === 'weekly'
          ? `周均 ${p.avg_weekly}${item.unit}`
          : `日均 ${p.avg_daily}${item.unit}`;
      const confLabel = { high: '高', medium: '中', low: '低' }[p.confidence] || p.confidence;
      const histLabel =
        p.mode === 'weekly' ? `${p.num_weeks} 周数据` : `${p.history_days} 天数据`;
      const chartHtml = buildMiniChart(p);
      const srcBaby = p.sources?.baby_log
        ? '<span class="pred-tag" style="background:#ede7f6;color:#5e35b1;margin-right:6px">宝宝日志</span> '
        : '';

      html += `
        <div class="restock-item" onclick="openItemDetail('${item.id}')" style="cursor:pointer">
          <div class="restock-top">
            <div class="restock-name">${escapeHtml(item.name)}</div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">${srcBaby}<span class="pred-tag pred-${urgency}">${p.restock_date ? p.restock_date + ' 前补' : '尽快'}</span></div>
          </div>
          <div class="restock-meta">
            当前库存 ${item.quantity}${item.unit} ·
            ${modeLabel} ·
            约 ${p.days_until_empty != null ? Math.round(p.days_until_empty) + ' 天后耗尽' : '未知'}
          </div>
          <div class="restock-meta" style="color:var(--subtext);font-size:11px">
            预测模式：${p.mode === 'weekly' ? '周均值' : '日均值'} ·
            置信度：${confLabel} ·
            基于 ${histLabel}
          </div>
          ${chartHtml}
        </div>`;
    });
    html += '</div>';
  }

  if (!html) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✋</div>
        <div class="empty-text">当前筛选下没有补货项</div>
        <div class="empty-sub">可尝试勾选更多渠道</div>
      </div>`;
    return;
  }

  container.innerHTML = html;
}

function buildMiniChart(p) {
  if (!p.breakdown || p.breakdown.length === 0) return '';

  const data = p.breakdown;
  const maxQty = Math.max(...data.map(d => d.qty), 0.01);
  const isWeekly = p.mode === 'weekly';
  const labelKey = isWeekly ? 'week' : 'date';

  const bars = data.map(d => {
    const h = Math.max(2, Math.round((d.qty / maxQty) * 24));
    const tip = isWeekly
      ? `${d.week} 周：${d.qty}`
      : `${d.date}：${d.qty}`;
    return `<div class="mini-bar" style="height:${h}px" title="${tip}"></div>`;
  }).join('');

  const firstLabel = data[0]?.[labelKey]?.slice(5) || '';  // MM-DD 或 MM-DD
  const lastLabel  = data[data.length - 1]?.[labelKey]?.slice(5) || '';

  return `
    <div class="chart-wrap">
      <div class="mini-chart">${bars}</div>
      <div class="mini-label"><span>${firstLabel}</span><span>${lastLabel}</span></div>
    </div>`;
}

async function quickConsume(id) {
  const item = allItems.find((i) => i.id === id);
  const name = item ? item.name : id;
  if (!confirm(`确认消耗 1 个「${name}」？`)) return;
  try {
    await fetch(`/api/items/${id}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty: 1 }),
    });
    showToast(`已记录消耗：${name}`);
    await refreshInventory();
    renderInventory();
  } catch (e) {
    showToast('操作失败：' + e.message);
  }
}

let _editingItemId = null;

function populateDetailSelects() {
  const catSel = document.getElementById('d-category');
  const locSel = document.getElementById('d-location');
  if (catSel) catSel.innerHTML = renderCategoryOptions();
  locSel.innerHTML = Object.entries(LOCATIONS)
    .map(([k, v]) => `<option value="${k}">${v.icon} ${k}</option>`)
    .join('');
}

function renderCommentsInModal(comments) {
  const el = document.getElementById('d-comments-list');
  if (!comments || !comments.length) {
    el.innerHTML = '<span style="color:var(--subtext)">暂无留言</span>';
    return;
  }
  el.innerHTML = comments
    .slice()
    .reverse()
    .map((c) => {
      const d = c.at ? new Date(c.at).toLocaleString('zh-CN') : '';
      return `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:0.5px solid var(--border)"><div style="font-size:11px;color:var(--subtext)">${escapeHtml(d)}</div><div>${escapeHtml(c.text)}</div></div>`;
    })
    .join('');
}

function openItemDetail(id) {
  const item = allItems.find((i) => i.id === id);
  if (!item) return;
  _editingItemId = id;
  populateDetailSelects();
  document.getElementById('d-icon').value = item.icon || '';
  document.getElementById('d-name').value = item.name || '';
  document.getElementById('d-brand').value = item.brand || '';
  document.getElementById('d-category').value = item.category;
  document.getElementById('d-qty').value = item.quantity;
  document.getElementById('d-unit').value = item.unit || '';
  document.getElementById('d-location').value = item.location;
  document.getElementById('d-expiry').value = item.expiry_date || '';
  setSourcePicker('d', getItemSources(item));
  document.getElementById('d-price').value = item.unit_price != null && item.unit_price !== '' ? item.unit_price : '';
  document.getElementById('d-priority').value = item.priority || '';
  const isFreq = !!item.frequent_restock;
  document.getElementById('d-frequent-restock').checked = isFreq;
  document.getElementById('d-restock-lead-group').style.display = isFreq ? 'block' : 'none';
  document.getElementById('d-restock-lead').value = item.restock_lead_days || 7;
  document.getElementById('d-restock-needed').checked = !!item.restock_needed;
  document.getElementById('d-notes').value = item.notes || '';
  document.getElementById('d-new-comment').value = '';
  const sg = document.getElementById('d-secret-group');
  const isDig = item.category === 'digital_voucher';
  if (sg) sg.style.display = isDig ? 'block' : 'none';
  const dsp = document.getElementById('d-secret-plaintext');
  if (dsp) dsp.value = '';
  const dr = document.getElementById('d-secret-revealed');
  if (dr) {
    dr.style.display = 'none';
    dr.textContent = '';
  }
  const dst = document.getElementById('d-secret-status');
  if (dst) {
    dst.textContent = item.has_encrypted_secret
      ? '已保存加密内容（可「显示」或输入新内容覆盖）'
      : '尚未保存卡号/券码密文';
  }
  
  // unit_spec fields
  const dsUsf = document.getElementById('d-unit-spec-fields');
  if (dsUsf) {
    const tmpl = CATEGORIES[item.category]?.unit_spec_template;
    const itemUs = item.unit_spec || {};
    if (tmpl || itemUs.sku_unit) {
      dsUsf.style.display = 'block';
      document.getElementById('d-us-sku-unit').value = itemUs.sku_unit || tmpl?.sku_unit || '';
      document.getElementById('d-us-spu-unit').value = itemUs.spu_unit || tmpl?.spu_unit || '';
      document.getElementById('d-us-spu-qty').value = itemUs.spu_qty || '';
    } else {
      dsUsf.style.display = 'none';
      document.getElementById('d-us-sku-unit').value = '';
      document.getElementById('d-us-spu-unit').value = '';
      document.getElementById('d-us-spu-qty').value = '';
    }
  }

  renderCommentsInModal(item.comments || []);
  document.getElementById('item-detail-modal').classList.add('show');
  document.getElementById('item-detail-modal').setAttribute('aria-hidden', 'false');
}

function closeItemDetail() {
  _editingItemId = null;
  const dr = document.getElementById('d-secret-revealed');
  if (dr) {
    dr.style.display = 'none';
    dr.textContent = '';
  }
  document.getElementById('item-detail-modal').classList.remove('show');
  document.getElementById('item-detail-modal').setAttribute('aria-hidden', 'true');
}

async function revealItemSecret() {
  if (!_editingItemId) return;
  try {
    const d = await fetchJson('/api/items/' + encodeURIComponent(_editingItemId) + '/secret');
    const el = document.getElementById('d-secret-revealed');
    if (!el) return;
    if (d.plaintext == null || d.plaintext === '') {
      showToast('暂无已保存的密文');
      return;
    }
    el.textContent = d.plaintext;
    el.style.display = 'block';
  } catch (e) {
    showToast(e.message || '无法读取');
  }
}

async function clearItemSecret() {
  if (!_editingItemId) return;
  if (!confirm('确定清除已保存的加密卡券信息？')) return;
  try {
    const r = await fetch('/api/items/' + encodeURIComponent(_editingItemId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear_encrypted_secret: true }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast(d.error || '失败');
      return;
    }
    showToast('已清除密文');
    const dr = document.getElementById('d-secret-revealed');
    if (dr) {
      dr.style.display = 'none';
      dr.textContent = '';
    }
    const dst = document.getElementById('d-secret-status');
    if (dst) dst.textContent = '尚未保存卡号/券码密文';
    await refreshInventory();
    renderInventory();
    openItemDetail(_editingItemId);
  } catch (e) {
    showToast(e.message || '失败');
  }
}

async function saveItemDetail() {
  if (!_editingItemId) return;
  const id = _editingItemId;
  const pr = document.getElementById('d-price').value;
  const payload = {
    name: document.getElementById('d-name').value.trim(),
    brand: document.getElementById('d-brand').value.trim() || null,
    category: document.getElementById('d-category').value,
    location: document.getElementById('d-location').value,
    quantity: document.getElementById('d-qty').value,
    unit: document.getElementById('d-unit').value,
    expiry_date: document.getElementById('d-expiry').value,
    sources: getSourcePicker('d'),
    unit_price: pr === '' || pr === undefined ? null : parseFloat(pr),
    icon: document.getElementById('d-icon').value,
    frequent_restock: document.getElementById('d-frequent-restock').checked,
    restock_lead_days: parseInt(document.getElementById('d-restock-lead').value) || 7,
    restock_needed: document.getElementById('d-restock-needed').checked,
    priority: document.getElementById('d-priority').value || null,
    notes: document.getElementById('d-notes').value.trim() || null,
  };
  if (payload.category === 'digital_voucher') {
    const sp = (document.getElementById('d-secret-plaintext')?.value || '').trim();
    if (sp) payload.secret_plaintext = sp;
  }
  
  // unit_spec (SKU/SPU)
  const usSkuUnit = (document.getElementById('d-us-sku-unit')?.value || '').trim();
  const usSpuUnit = (document.getElementById('d-us-spu-unit')?.value || '').trim();
  const usSpuQty  = parseInt(document.getElementById('d-us-spu-qty')?.value || '', 10);
  if (usSkuUnit && usSpuUnit) {
    payload.unit_spec = {
      sku_unit: usSkuUnit,
      spu_unit: usSpuUnit,
      spu_qty: Number.isFinite(usSpuQty) && usSpuQty > 0 ? usSpuQty : null,
    };
  } else {
    // If fields are empty but were perhaps filled before, we might want to allow clearing them
    payload.unit_spec = null; 
  }
  
  if (!payload.name) {
    showToast('名称不能为空');
    return;
  }
  try {
    const r = await fetch(`/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast('❌ ' + (d.error || '保存失败'));
      return;
    }
    showToast('✓ 已保存');
    await refreshInventory();
    renderInventory();
    closeItemDetail();
  } catch (e) {
    showToast('❌ ' + e.message);
  }
}

async function deleteItemFromDetail() {
  if (!_editingItemId) return;
  const name = document.getElementById('d-name').value;
  if (!confirm(`确认删除「${name}」？这无法撤销。`)) return;
  try {
    const r = await fetch(`/api/items/${_editingItemId}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) {
      showToast('❌ ' + (d.error || '删除失败'));
      return;
    }
    showToast('✓ 已删除');
    closeItemDetail();
    await refreshInventory();
    renderInventory();
  } catch (e) {
    showToast('❌ ' + e.message);
  }
}

async function addItemComment() {
  if (!_editingItemId) return;
  const text = (document.getElementById('d-new-comment').value || '').trim();
  if (!text) return;
  try {
    const r = await fetch(`/api/items/${_editingItemId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    if (!r.ok) {
      showToast('❌ ' + (d.error || '失败'));
      return;
    }
    document.getElementById('d-new-comment').value = '';
    await refreshInventory();
    renderCommentsInModal(d.item.comments || []);
  } catch (e) {
    showToast('❌ ' + e.message);
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── 宝宝模块 ─────────────────────────────────────────────────────────────────

let babyDateOffset = 0;

function getBabyDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + babyDateOffset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function shiftBabyDate(delta) {
  babyDateOffset += delta;
  if (babyDateOffset > 0) babyDateOffset = 0;
  updateBabyDateLabel();
  loadBabyTimeline();
}

function updateBabyDateLabel() {
  const label = document.getElementById('baby-date-label');
  if (babyDateOffset === 0) label.textContent = '今天';
  else if (babyDateOffset === -1) label.textContent = '昨天';
  else label.textContent = getBabyDateStr();
}

async function loadBabyStats() {
  try {
    const r = await fetch('/api/baby-log/stats');
    const d = await r.json();
    if (d.baby) {
      document.getElementById('baby-name').textContent = `👶 ${d.baby.name}`;
      if (d.baby.dob) {
        const dob = new Date(d.baby.dob);
        const now = new Date();
        const diffDays = Math.floor((now - dob) / 86400000);
        const months = Math.floor(diffDays / 30);
        const days = diffDays % 30;
        document.getElementById('baby-age').textContent = `${d.baby.dob} 出生 · ${months}个月${days}天 · 共 ${d.total_events} 条记录`;
      }
    }
    document.getElementById('bs-feed').textContent = d.today.feeding_count;
    document.getElementById('bs-ml').textContent = d.today.feeding_total_ml;
    document.getElementById('bs-diaper').textContent = d.today.diaper_count;
    document.getElementById('bs-sleep').textContent = d.today.sleep_total_min || '-';
  } catch (e) {}
}

async function loadBabyTimeline() {
  const dateStr = getBabyDateStr();
  const container = document.getElementById('baby-timeline');
  container.innerHTML = '<div class="loading"><div class="spinner"></div> 加载中...</div>';

  try {
    const r = await fetch(`/api/baby-log?date=${dateStr}&limit=100`);
    const d = await r.json();

    if (d.events.length === 0) {
      container.innerHTML = `
        <div class="empty" style="padding:32px 16px">
          <div class="empty-icon">📝</div>
          <div class="empty-text">暂无记录</div>
          <div class="empty-sub">点击上方按钮开始记录</div>
        </div>`;
      return;
    }

    container.innerHTML = d.events.map(e => {
      const meta = eventMeta(e);
      const timeStr = e.time.split('T')[1]?.slice(0,5) || '';
      return `
        <div class="timeline-item">
          <div class="timeline-icon ${meta.iconClass}">${meta.icon}</div>
          <div class="timeline-body">
            <div class="timeline-title">${meta.title}</div>
            <div class="timeline-detail">${meta.detail}</div>
          </div>
          <div class="timeline-time">${timeStr}</div>
          <button class="timeline-delete" onclick="deleteBabyEvent('${e.id}')" title="删除">×</button>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="loading" style="color:var(--danger)">加载失败</div>';
  }
}

function eventMeta(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'feeding_bottle':
      return {
        icon: '🍼',
        iconClass: 'timeline-icon-feeding',
        title: '奶瓶喂奶',
        detail: `${d.amount_ml || '?'} ml${d.milk_type === 'ready_to_feed' || d.milk_type === 'water_milk' ? ' · 水奶' : ''}${d.reaction ? ' · ' + d.reaction : ''}${d.note ? ' · ' + d.note : ''}`,
      };
    case 'feeding_nursing':
      return { icon: '🤱', iconClass: 'timeline-icon-feeding', title: '母乳', detail: `${d.total_min || '?'} 分钟${d.note ? ' · ' + d.note : ''}` };
    case 'feeding_solid':
      return { icon: '🥣', iconClass: 'timeline-icon-feeding', title: '辅食', detail: `${d.food || ''}${d.note ? ' · ' + d.note : ''}` };
    case 'diaper': {
      const statusMap = { wet: '小便', dirty: '大便', wet_and_dirty: '大小便', unknown: '未知' };
      return { icon: '🩲', iconClass: 'timeline-icon-diaper', title: '换尿布', detail: `${statusMap[d.status] || d.status || ''}${d.note ? ' · ' + d.note : ''}` };
    }
    case 'sleep':
      return { icon: '😴', iconClass: 'timeline-icon-sleep', title: '睡眠', detail: `${d.duration_min || '?'} 分钟${d.note ? ' · ' + d.note : ''}` };
    case 'growth': {
      const parts = [];
      if (d.weight_kg) parts.push(`体重 ${d.weight_kg}kg`);
      if (d.length_cm) parts.push(`身长 ${d.length_cm}cm`);
      if (d.head_cm) parts.push(`头围 ${d.head_cm}cm`);
      return { icon: '📏', iconClass: 'timeline-icon-growth', title: '生长记录', detail: parts.join(' · ') || '无数据' };
    }
    default:
      return { icon: '📌', iconClass: 'timeline-icon-other', title: e.type, detail: d.note || '' };
  }
}

async function deleteBabyEvent(id) {
  if (!confirm('确认删除这条记录？')) return;
  try {
    await fetch(`/api/baby-log/${id}`, { method: 'DELETE' });
    showToast('已删除');
    loadBabyTimeline();
    loadBabyStats();
  } catch (e) {
    showToast('删除失败');
  }
}

// ── 手动输入模态 ──

const MODAL_CONFIGS = {
  feeding_bottle: {
    title: '🍼 记录喂奶',
    fields: `
      <div class="form-group">
        <label class="form-label">类型</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:14px">
          <label class="form-check" style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0">
            <input type="radio" name="bf-milk-type" value="powder" checked> 奶粉冲调
          </label>
          <label class="form-check" style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0">
            <input type="radio" name="bf-milk-type" value="ready_to_feed"> 水奶
          </label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">奶量 (ml) *</label>
        <input type="number" class="form-input" id="bf-amount" required placeholder="如 120" min="1" max="1000" step="1">
      </div>
      <div class="form-group">
        <label class="form-label">备注</label>
        <input type="text" class="form-input" id="bf-note" placeholder="如 吐奶、喝很快等">
      </div>`,
    collect: () => {
      const mt =
        (document.querySelector('input[name="bf-milk-type"]:checked') || {}).value || 'powder';
      return {
        amount_ml: parseInt(document.getElementById('bf-amount').value, 10),
        milk_type: mt === 'ready_to_feed' ? 'ready_to_feed' : 'powder',
        note: document.getElementById('bf-note').value || null,
      };
    },
  },
  diaper: {
    title: '🩲 记录换尿布',
    fields: `
      <div class="form-group">
        <label class="form-label">类型 *</label>
        <select class="form-select" id="bf-status" required>
          <option value="wet">小便 (wet)</option>
          <option value="dirty">大便 (dirty)</option>
          <option value="wet_and_dirty">大小便 (both)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">备注</label>
        <input type="text" class="form-input" id="bf-note" placeholder="如 颜色、量等">
      </div>`,
    collect: () => ({ status: document.getElementById('bf-status').value, note: document.getElementById('bf-note').value || null }),
  },
  sleep: {
    title: '😴 记录睡眠',
    fields: `
      <div class="form-group">
        <label class="form-label">时长 (分钟) *</label>
        <input type="number" class="form-input" id="bf-duration" required placeholder="如 90" min="1" max="1440">
      </div>
      <div class="form-group">
        <label class="form-label">备注</label>
        <input type="text" class="form-input" id="bf-note" placeholder="如 午睡、闹觉等">
      </div>`,
    collect: () => ({ duration_min: parseInt(document.getElementById('bf-duration').value), note: document.getElementById('bf-note').value || null }),
  },
  growth: {
    title: '📏 记录生长',
    fields: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">体重 (kg)</label>
          <input type="number" class="form-input" id="bf-weight" placeholder="如 5.5" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">身长 (cm)</label>
          <input type="number" class="form-input" id="bf-length" placeholder="如 58" step="0.1" min="0">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">头围 (cm)</label>
        <input type="number" class="form-input" id="bf-head" placeholder="如 37" step="0.1" min="0">
      </div>
      <div class="form-group">
        <label class="form-label">备注</label>
        <input type="text" class="form-input" id="bf-note" placeholder="如 体检数据">
      </div>`,
    collect: () => ({
      weight_kg: parseFloat(document.getElementById('bf-weight').value) || null,
      length_cm: parseFloat(document.getElementById('bf-length').value) || null,
      head_cm: parseFloat(document.getElementById('bf-head').value) || null,
      note: document.getElementById('bf-note').value || null,
    }),
  },
};

function openBabyModal(type) {
  const cfg = MODAL_CONFIGS[type];
  if (!cfg) return;

  document.getElementById('bf-type').value = type;
  document.getElementById('modal-title').textContent = cfg.title;
  document.getElementById('modal-fields').innerHTML = cfg.fields;

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('bf-time').value =
    `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

  document.getElementById('baby-modal').style.display = 'flex';
}

function closeBabyModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('baby-modal').style.display = 'none';
}

async function submitBabyEvent(e) {
  e.preventDefault();
  const type = document.getElementById('bf-type').value;
  const cfg = MODAL_CONFIGS[type];
  if (!cfg) return;

  const timeVal = document.getElementById('bf-time').value;
  const time = timeVal ? timeVal.replace('T', 'T') + ':00' : null;
  const data = cfg.collect();

  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    const r = await fetch('/api/baby-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, time, data }),
    });
    const d = await r.json();
    if (d.success) {
      showToast('✓ 已记录');
      closeBabyModal();
      loadBabyTimeline();
      loadBabyStats();
    } else {
      showToast('❌ ' + (d.error || '记录失败'));
    }
  } catch (err) {
    showToast('❌ 网络错误');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ 确认记录';
  }
}

// ── btcp 上传 ──

function setupBtcpDragDrop() {
  const zone = document.getElementById('btcp-upload-zone');
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadBtcpFile(file);
  });
}

function handleBtcpUpload(e) {
  const file = e.target.files[0];
  if (file) uploadBtcpFile(file);
  e.target.value = '';
}

async function uploadBtcpFile(file) {
  const progress = document.getElementById('btcp-progress');
  const progressText = document.getElementById('btcp-progress-text');
  progress.style.display = 'block';
  progressText.textContent = `正在导入 ${file.name}...`;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const r = await fetch('/api/import/btcp', { method: 'POST', body: formData });
    const d = await r.json();
    if (d.success) {
      const msg = d.imported > 0
        ? `✅ 导入成功！新增 ${d.imported} 条，跳过 ${d.skipped} 条`
        : `⚠️ 没有新数据（已跳过 ${d.skipped} 条重复记录）`;
      progressText.textContent = msg;
      showToast(msg);
      loadBabyStats();
      loadBabyTimeline();
    } else {
      progressText.textContent = '❌ ' + (d.error || '导入失败');
      showToast('❌ 导入失败');
    }
  } catch (e) {
    progressText.textContent = '❌ 网络错误';
    showToast('❌ 网络错误');
  }

  setTimeout(() => { progress.style.display = 'none'; }, 5000);
}

// ─── 启动 ─────────────────────────────────────────────────────────────────────
init();
