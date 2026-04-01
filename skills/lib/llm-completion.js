/**
 * llm-completion.js — Reusable LLM completion skill
 *
 * Supports three backends:
 *   - "http"  : Call any OpenAI-compatible API (needs api_key + completion_url)
 *   - "cli"   : Spawn a local CLI tool (claude / gemini / codex / openclaw …)
 *   - "cli" + streaming : SSE-friendly streaming variant for long-running CLIs
 *
 * Usage:
 *   const { complete, completeStreaming, llmOk, CLI_PRESETS } = require('./lib/llm-completion');
 *   const result = await complete(llm, prompt, { maxTokens: 3500, stats });
 *   // result: { ok, text?, error? }
 */

const fs = require("fs");
const { spawn } = require("child_process");

/* ─── CLI presets (shared between server & frontend) ──────────────────────── */

const CLI_PRESETS = {
  claude:   { command: "claude",   args: ["-p", "<<<PROMPT>>>"], label: "Claude Code（claude -p）" },
  openclaw: { command: "openclaw", args: ["run", "--prompt", "<<<PROMPT>>>"], label: "OpenClaw（openclaw run）" },
  gemini:   { command: "gemini",   args: ["-p", "<<<PROMPT>>>"], label: "Gemini CLI（gemini -p）" },
  codex:    { command: "codex",    args: ["-p", "<<<PROMPT>>>"], label: "Codex CLI（codex -p）" },
};

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function escapeForJsonStringContent(s) {
  return JSON.stringify(String(s)).slice(1, -1);
}

function expandCliArgPlaceholders(s, llm, prompt, stats) {
  const model = String(llm.model || "").trim();
  return String(s)
    .replace(/<<<PROMPT>>>/g, prompt)
    .replace(/<<<MODEL>>>/g, model)
    .replace(/<<<COUNT>>>/g, String((stats && stats.count) || 0))
    .replace(/<<<URGENT>>>/g, String((stats && stats.urgent) || 0))
    .replace(/<<<URGENT_DAYS>>>/g, String((stats && stats.urgent_threshold_days) || 3));
}

function normalizeCliArgs(llm, prompt, stats) {
  const raw = llm.cli_args;
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { ok: false, error: "cli_args 须为 JSON 数组" };
      arr = parsed;
    } catch (e) {
      return { ok: false, error: `cli_args JSON 无效：${e.message || e}` };
    }
  } else {
    return { ok: false, error: '请配置 cli_args（JSON 数组），例如 ["-p","<<<PROMPT>>>"]' };
  }
  const args = arr.map((a) => expandCliArgPlaceholders(a, llm, prompt, stats));
  return { ok: true, args };
}

function resolveCliOpts(llm) {
  const timeoutRaw = llm.cli_timeout_ms;
  const timeoutMs = Math.min(Math.max(parseInt(timeoutRaw, 10) || 120000, 5000), 600000);
  const cwdRaw = llm.cli_cwd != null ? String(llm.cli_cwd).trim() : "";
  let cwd;
  if (cwdRaw) {
    if (!fs.existsSync(cwdRaw)) return { ok: false, error: `cli_cwd 不存在：${cwdRaw}` };
    cwd = cwdRaw;
  }
  return { ok: true, timeoutMs, cwd };
}

function applyLlmAuthHeaders(headers, llm, key) {
  const style = llm.auth_style || "bearer";
  if (style === "none") return;
  if (style === "x_api_key") {
    headers["x-api-key"] = key;
    return;
  }
  headers.Authorization = `Bearer ${key}`;
}

function extractCompletionText(json) {
  if (json == null) return "";
  if (typeof json === "string") return json.trim();
  const c0 = json.choices && json.choices[0];
  if (c0?.message?.content != null) return String(c0.message.content).trim();
  if (c0?.text != null) return String(c0.text).trim();
  const cand = json.candidates && json.candidates[0];
  if (cand?.content?.parts?.[0]?.text != null) return String(cand.content.parts[0].text).trim();
  if (json.content != null) return String(json.content).trim();
  if (json.output_text != null) return String(json.output_text).trim();
  return "";
}

/* ─── Validation ──────────────────────────────────────────────────────────── */

/**
 * Check whether LLM config is sufficient for completion calls.
 */
function llmOk(llm) {
  if (!llm || typeof llm !== "object") return false;
  const backend = String(llm.backend || "http").toLowerCase();
  if (backend === "cli") return !!String(llm.cli_command || "").trim();
  const url = String(llm.completion_url || "").trim();
  if (!url) return false;
  const authStyle = llm.auth_style || "bearer";
  const key = String(llm.api_key || "").trim();
  if (authStyle !== "none" && !key) return false;
  return true;
}

/* ─── CLI completion (blocking) ───────────────────────────────────────────── */

function runSpawned(command, args, opts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const proc = spawn(command, args, {
      shell: false,
      env: { ...process.env },
      cwd: opts.cwd || undefined,
    });
    let out = "";
    let err = "";
    const timeoutMs = opts.timeoutMs || 120000;
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
      finish(reject, new Error(`CLI 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 2_000_000) {
        try { proc.kill("SIGKILL"); } catch (_) {}
      }
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(t);
      finish(reject, e);
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (settled) return;
      if (code !== 0 && !out.trim()) {
        finish(reject, new Error((err || `退出码 ${code}`).slice(0, 1200)));
        return;
      }
      finish(resolve, { stdout: out, stderr: err, code: code || 0 });
    });
  });
}

async function completeCli(llm, prompt, stats) {
  const cmd = String(llm.cli_command || "").trim();
  if (!cmd) return { ok: false, error: "请配置本地 CLI 命令（cli_command）" };
  const norm = normalizeCliArgs(llm, prompt, stats);
  if (!norm.ok) return norm;
  const opts = resolveCliOpts(llm);
  if (!opts.ok) return opts;
  try {
    const { stdout, stderr, code } = await runSpawned(cmd, norm.args, opts);
    let text = stripAnsi(stdout).trim();
    if (!text && stderr.trim()) text = stripAnsi(stderr).trim();
    if (!text) return { ok: false, error: code !== 0 ? (stderr || `CLI 退出码 ${code}`).slice(0, 800) : "CLI 无输出" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/* ─── HTTP completion ─────────────────────────────────────────────────────── */

async function completeHttp(llm, prompt, maxTokens) {
  const url = String(llm.completion_url || "").trim();
  const key = String(llm.api_key || "").trim();
  const authStyle = llm.auth_style || "bearer";
  if (!url) return { ok: false, error: "请先配置 completion URL，或改用「本地 CLI」" };
  if (authStyle !== "none" && !key) return { ok: false, error: "请先配置 API Key，或将鉴权改为「无」" };

  const model = String(llm.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
  const mt = Math.min(Math.max(parseInt(maxTokens, 10) || 2000, 50), 8000);

  let bodyObj;
  const tpl = llm.body_template != null ? String(llm.body_template).trim() : "";
  if (tpl) {
    try {
      const raw = tpl
        .replace(/<<<MODEL>>>/g, model)
        .replace(/<<<PROMPT>>>/g, escapeForJsonStringContent(prompt));
      bodyObj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `body_template 解析失败：${e.message || e}` };
    }
  } else {
    bodyObj = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: mt,
    };
  }

  const headers = { "Content-Type": "application/json" };
  applyLlmAuthHeaders(headers, llm, key);

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyObj) });
  const text = await r.text();
  if (!r.ok) return { ok: false, error: text.slice(0, 800) || `HTTP ${r.status}` };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "响应不是 JSON" }; }
  const out = extractCompletionText(json);
  if (!out) return { ok: false, error: "模型未返回可用文本" };
  return { ok: true, text: out };
}

/* ─── Unified complete() ──────────────────────────────────────────────────── */

/**
 * Run an LLM completion (blocking). Chooses backend automatically.
 * @param {object} llm - llm config from preferences
 * @param {string} prompt
 * @param {{ maxTokens?: number, stats?: object }} opts
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
async function complete(llm, prompt, opts = {}) {
  const backend = String((llm && llm.backend) || "http").toLowerCase();
  const stats = opts.stats || { count: 0, urgent: 0, urgent_threshold_days: 3 };
  if (backend === "cli") return completeCli(llm, prompt, stats);
  return completeHttp(llm, prompt, opts.maxTokens || 2000);
}

/* ─── SSE streaming helpers ───────────────────────────────────────────────── */

/**
 * Set up an Express response for SSE streaming.
 * @param {import('express').Response} res
 * @returns {{ send(obj): void, sendError(msg): void }}
 */
function setupSseResponse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const sendError = (msg) => {
    send({ error: msg });
    if (!res.writableEnded) res.end();
  };
  return { send, sendError };
}

/**
 * Stream CLI stdout chunks via SSE, return full accumulated text.
 * @param {(obj: object) => void} send - SSE send helper
 * @param {object} llm - llm config
 * @param {string} prompt
 * @param {object} stats
 * @param {AbortSignal|null} abortSignal - abort on client disconnect
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
function completeCliStreaming(send, llm, prompt, stats, abortSignal) {
  const cmd = String(llm.cli_command || "").trim();
  if (!cmd) return Promise.resolve({ ok: false, error: "请配置本地 CLI 命令（cli_command）" });
  const norm = normalizeCliArgs(llm, prompt, stats);
  if (!norm.ok) return Promise.resolve(norm);
  const opts = resolveCliOpts(llm);
  if (!opts.ok) return Promise.resolve(opts);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proc = spawn(cmd, norm.args, {
      shell: false,
      env: { ...process.env },
      cwd: opts.cwd || undefined,
    });

    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
      send({ error: `CLI 超时（${opts.timeoutMs}ms）` });
      finish({ ok: false, error: `CLI 超时（${opts.timeoutMs}ms）` });
    }, opts.timeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        try { proc.kill("SIGKILL"); } catch (_) {}
        finish({ ok: false, error: "客户端断开" });
      }, { once: true });
    }

    proc.stdout.on("data", (d) => {
      const chunk = stripAnsi(d.toString());
      out += chunk;
      if (out.length > 2_000_000) {
        try { proc.kill("SIGKILL"); } catch (_) {}
        return;
      }
      send({ chunk });
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message || String(e) });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      let text = out.trim();
      if (!text && err.trim()) text = stripAnsi(err).trim();
      if (!text) {
        finish({ ok: false, error: code !== 0 ? (err || `退出码 ${code}`).slice(0, 800) : "CLI 无输出" });
        return;
      }
      finish({ ok: true, text });
    });
  });
}

/* ─── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  CLI_PRESETS,
  llmOk,
  complete,
  completeCli,
  completeHttp,
  completeCliStreaming,
  setupSseResponse,
  // Low-level helpers for callers that need them
  stripAnsi,
  extractCompletionText,
  escapeForJsonStringContent,
  expandCliArgPlaceholders,
};
