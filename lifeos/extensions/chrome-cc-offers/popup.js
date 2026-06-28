'use strict';

/**
 * popup.js — grab the active tab's title/url/text, let the user trim it,
 * POST it to lifeos as a Capture with hints.kind='cc_offers'.
 *
 * 设计要点 / design notes:
 *  - 不在客户端做 offer 抽取 —— 服务端 parseOffers (+ LLM 兜底) 是单一真源。
 *  - hints.kind='cc_offers' 让服务端规则确定性命中 credit_card.bulk_offers。
 *  - Token 可选；未配置则不带 Authorization 头。
 */

const els = {
  title: document.getElementById('title'),
  url: document.getElementById('url'),
  text: document.getElementById('text'),
  send: document.getElementById('send'),
  result: document.getElementById('result'),
  resultSummary: document.getElementById('result-summary'),
  resultList: document.getElementById('result-list'),
  resultDetail: document.getElementById('result-detail'),
  warn: document.getElementById('config-warning'),
  openOptions: document.getElementById('open-options'),
  openOptionsFooter: document.getElementById('open-options-footer'),
};

let pageInfo = { title: '', url: '', text: '' };

/** Read endpoint + token from chrome.storage.sync. */
function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ endpoint: '', token: '' }, (cfg) => resolve(cfg || {}));
  });
}

/** Open the extension's own options page. */
function openOptions(e) {
  if (e) e.preventDefault();
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL('options.html'));
}
els.openOptions.addEventListener('click', openOptions);
els.openOptionsFooter.addEventListener('click', openOptions);

/** Pull the page's title + url + visible body text via scripting.executeScript. */
async function grabActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('no active tab');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title,
      // 200KB 上限，避免极长页面把 popup 卡住；后端再次受 1MB 限制。
      // 200KB cap so the popup doesn't choke; server enforces 1MB on its side.
      text: (document.body && document.body.innerText || '').slice(0, 200000),
      url: location.href,
    }),
  });
  return result || { title: tab.title, text: '', url: tab.url };
}

/** POST the capture to {endpoint}/api/captures and render the result. */
async function sendCapture() {
  els.send.disabled = true;
  els.result.classList.add('hidden');

  const cfg = await loadConfig();
  if (!cfg.endpoint) {
    els.warn.classList.remove('hidden');
    els.send.disabled = false;
    return;
  }

  const body = {
    text: els.text.value,
    channel: 'chrome-cc-offers',
    hints: {
      domain: 'finance',
      kind: 'cc_offers',
      url: pageInfo.url,
      title: pageInfo.title,
    },
  };

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;

  let res, json;
  try {
    res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/api/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    showResult({ ok: false, error: `Network error: ${e.message}` });
    els.send.disabled = false;
    return;
  }

  if (!res.ok) {
    showResult({ ok: false, error: `HTTP ${res.status}: ${json && (json.error || json.detail) || res.statusText}` });
    els.send.disabled = false;
    return;
  }

  showResult({ ok: true, json });
  els.send.disabled = false;
}

/** Render the API response: count, first 5 card names, raw blob in muted. */
function showResult({ ok, json, error }) {
  els.result.classList.remove('hidden');
  els.resultList.innerHTML = '';
  if (!ok) {
    els.resultSummary.textContent = 'Failed.';
    els.resultDetail.textContent = error || '';
    return;
  }
  const status = json.status || 'ok';
  const route = json.route || {};
  const cap = json.capture || {};
  const offerCount = (cap.data && cap.data.offer_count) || (route.args && route.args.offers && route.args.offers.length) || null;
  const resultIds = (cap.data && cap.data.result_ids) || (json.result_id ? [json.result_id] : []);

  const parts = [`Status: ${status}`];
  if (route.intent) parts.push(`Routed to: ${route.intent}`);
  if (offerCount !== null) parts.push(`Offers: ${offerCount}`);
  if (resultIds.length) parts.push(`Created: ${resultIds.length} planned application(s)`);
  els.resultSummary.textContent = parts.join(' · ');

  // 首 5 张卡名（若服务端有把 args 回灌进 capture.data）
  const cardNames = (cap.data && cap.data.offers ? cap.data.offers : [])
    .slice(0, 5)
    .map((o) => o.card_name)
    .filter(Boolean);
  for (const n of cardNames) {
    const li = document.createElement('li');
    li.textContent = n;
    els.resultList.appendChild(li);
  }

  els.resultDetail.textContent =
    `Review them in your lifeos inbox tab (收件).\n\nRaw: ` + JSON.stringify(json, null, 2);
}

/** Boot: pull tab info → fill UI → wire submit. */
(async function init() {
  try {
    pageInfo = await grabActiveTab();
  } catch (e) {
    pageInfo = { title: '(unable to read page)', url: '', text: '' };
    els.resultDetail.textContent = `Could not read page: ${e.message}`;
  }
  els.title.textContent = pageInfo.title || '(untitled)';
  els.url.textContent = pageInfo.url || '';
  els.text.value = pageInfo.text || '';

  const cfg = await loadConfig();
  if (!cfg.endpoint) {
    els.warn.classList.remove('hidden');
  }
  els.send.disabled = false;
  els.send.addEventListener('click', sendCapture);
})();
