'use strict';

/**
 * http.js — 带友好 User-Agent 与超时的轻量 fetch 助手。
 * Tiny fetch helpers with a friendly User-Agent and timeout.
 * Node 18+ 提供全局 `fetch`。Node 18+ provides a global `fetch`.
 */

const UA =
  'lifeos-ingest/0.1 (+https://github.com/buddhistrhythm/claw-household)';

async function httpText(url, opts = {}) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { httpText, UA };
