'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { freshStore } = require('./helpers');
const capture = require('../src/capture');
const financeDomain = require('../src/domains/finance');
const { startWebhookSource } = require('../src/capture/sources/webhook');
const { watchFolder } = require('../src/capture/sources/watchfolder');

test('capture: rule-matched storage.add_item auto-commits with captured_from edge', async () => {
  const store = await freshStore();
  const api = capture(store);
  try {
    const out = await api.ingest({
      channel: 'test', source_ref: 'msg-1', text: '加 3 盒 牛奶',
    });
    assert.equal(out.status, 'committed');
    assert.equal(out.route.intent, 'storage.add_item');
    assert.equal(out.route.by, 'rule');
    assert.equal(out.route.confidence, 1);
    assert.ok(out.result_id);

    // capture 实体已 committed，data.route 记录了决策
    const cap = await store.entities.get(out.id);
    assert.equal(cap.status, 'committed');
    assert.equal(cap.data.route.intent, 'storage.add_item');
    assert.equal(cap.data.result_id, out.result_id);

    // 物品建对了：牛奶 ×3 盒
    const item = await store.entities.get(out.result_id);
    assert.equal(item.type, 'item');
    assert.equal(item.title, '牛奶');
    assert.equal(item.data.quantity, 3);
    assert.equal(item.data.unit, '盒');

    // 溯源边 item -[captured_from]-> capture
    const edges = await store.relations.from(item.id, 'captured_from');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].object_id, out.id);
  } finally { await store.close(); }
});

test('capture: add_item with location find-or-creates the storage_location', async () => {
  const store = await freshStore();
  const api = capture(store);
  try {
    const out = await api.ingest({ channel: 'test', source_ref: 'loc-1', text: '加 2 罐 番茄罐头 到 储藏柜' });
    assert.equal(out.status, 'committed');
    const locs = await store.entities.list({ type: 'storage_location' });
    assert.equal(locs.length, 1);
    assert.equal(locs[0].title, '储藏柜');
    const placed = await store.relations.from(out.result_id, 'stored_in');
    assert.equal(placed[0].object_id, locs[0].id);
  } finally { await store.close(); }
});

test('capture: finance rule matches but confirm:always parks pending; confirm() commits', async () => {
  const store = await freshStore();
  const api = capture(store);
  const finance = financeDomain(store);
  try {
    await finance.createAccount({ name: 'Chase Checking', kind: 'checking' });

    // 钱 NEVER 自动落库：规则命中（置信 1）也要 pending
    const out = await api.ingest({ channel: 'test', source_ref: 'txn-1', text: '花了 $12.99 咖啡' });
    assert.equal(out.status, 'pending');
    assert.equal(out.route.intent, 'finance.add_txn');
    assert.equal(out.route.by, 'rule');
    assert.equal(out.route.args.amount_cents, 1299);
    assert.equal(out.route.args.direction, 'debit');

    // pending 队列里能看到建议
    const queue = await api.pending();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].suggestion.intent, 'finance.add_txn');

    // 人工确认（补上账户）：建议 args 与覆盖合并
    const confirmed = await api.confirm(out.id, { args: { account: 'Chase Checking' } });
    assert.equal(confirmed.status, 'committed');
    const txn = await store.entities.get(confirmed.result_id);
    assert.equal(txn.type, 'finance_txn');
    assert.equal(txn.data.amount_cents, 1299);
    assert.equal(txn.data.direction, 'debit');
    assert.equal(txn.data.merchant, '咖啡');

    const cap = await store.entities.get(out.id);
    assert.equal(cap.status, 'committed');
    const edges = await store.relations.from(txn.id, 'captured_from');
    assert.equal(edges[0].object_id, out.id);

    // 已 committed 的不能再 confirm
    await assert.rejects(() => api.confirm(out.id), /already committed/);
  } finally { await store.close(); }
});

test('capture: no rule + no llm → pending; explicit confirm + dismiss work', async () => {
  const store = await freshStore();
  const api = capture(store);
  try {
    const out = await api.ingest({ channel: 'test', source_ref: 'free-1', text: 'hello world nothing matches here' });
    assert.equal(out.status, 'pending');
    assert.equal(out.route, null);

    // 人工指定 intent + args
    const confirmed = await api.confirm(out.id, {
      intent: 'notes.add_note', args: { title: 'manual note', body: 'from free text' },
    });
    assert.equal(confirmed.status, 'committed');
    const note = await store.entities.get(confirmed.result_id);
    assert.equal(note.type, 'note');
    assert.equal(note.title, 'manual note');

    // dismiss 另一条
    const out2 = await api.ingest({ channel: 'test', source_ref: 'free-2', text: 'random again' });
    assert.equal(out2.status, 'pending');
    const dismissed = await api.dismiss(out2.id);
    assert.equal(dismissed.status, 'dismissed');
    assert.equal((await store.entities.get(out2.id)).status, 'dismissed');
    assert.equal((await api.pending()).length, 0);

    // 未知 capture 报错
    await assert.rejects(() => api.dismiss('cap_nope'), /not found/);
  } finally { await store.close(); }
});

test('capture: rule-hit intent whose run() fails stays pending with error', async () => {
  const store = await freshStore();
  const api = capture(store);
  try {
    // storage.place 规则命中，但物品/位置都不存在 → run throw → pending
    const out = await api.ingest({ channel: 'test', source_ref: 'place-1', text: '把护照放到第二抽屉' });
    assert.equal(out.status, 'pending');
    assert.equal(out.route.intent, 'storage.place');
    assert.match(out.error, /not found/);
    const cap = await store.entities.get(out.id);
    assert.equal(cap.status, 'pending');
    assert.match(cap.data.error, /not found/);
  } finally { await store.close(); }
});

test('capture: duplicate source_ref is idempotent — no second capture entity', async () => {
  const store = await freshStore();
  const api = capture(store);
  try {
    const first = await api.ingest({ channel: 'test', source_ref: 'dup-1', text: '记 买鸡蛋' });
    assert.equal(first.status, 'committed');
    const second = await api.ingest({ channel: 'test', source_ref: 'dup-1', text: '记 买鸡蛋' });
    assert.equal(second.status, 'duplicate');
    assert.equal(second.id, first.id);
    const caps = await store.entities.list({ type: 'capture' });
    assert.equal(caps.length, 1);
  } finally { await store.close(); }
});

test('capture: LLM fallback auto-commits notes (confirm:never, confidence ≥ 0.8), by:llm', async () => {
  const store = await freshStore();
  // 注入式 stub —— 测试离线，绝不打真 API
  const llm = {
    calls: [],
    async routeCapture({ capture: c, tools }) {
      this.calls.push({ text: c.text, tools: tools.map((t) => t.name) });
      return { intent: 'notes.add_note', args: { title: 'from llm' }, confidence: 0.9 };
    },
  };
  const api = capture(store, { llm });
  try {
    const out = await api.ingest({ channel: 'test', source_ref: 'llm-1', text: 'milk is running low, fyi' });
    assert.equal(out.status, 'committed');
    assert.equal(out.route.by, 'llm');
    assert.equal(out.route.confidence, 0.9);

    // 工具集（= Intent 集）以 JSON Schema 形式交给了 LLM
    assert.equal(llm.calls.length, 1);
    assert.ok(llm.calls[0].tools.includes('storage.add_item'));
    assert.ok(llm.calls[0].tools.includes('finance.add_txn'));

    const cap = await store.entities.get(out.id);
    assert.equal(cap.data.route.by, 'llm');
    const note = await store.entities.get(out.result_id);
    assert.equal(note.title, 'from llm');
  } finally { await store.close(); }
});

test('capture: LLM low confidence (or confirm!=never) goes pending', async () => {
  const store = await freshStore();
  const llm = {
    async routeCapture() {
      return { intent: 'storage.add_item', args: { name: 'guessy item' }, confidence: 0.95 };
    },
  };
  const api = capture(store, { llm });
  try {
    // storage.add_item 的 confirm 是 'low'（≠'never'）→ LLM 路由不自动落库
    const out = await api.ingest({ channel: 'test', source_ref: 'llm-2', text: 'something about an item maybe' });
    assert.equal(out.status, 'pending');
    assert.equal(out.route.by, 'llm');
    assert.equal((await store.entities.list({ type: 'item' })).length, 0);
  } finally { await store.close(); }
});

test('webhook source: secret enforced; valid POST routes through the pipeline', async () => {
  const store = await freshStore();
  const api = capture(store);
  const src = await startWebhookSource({ captureApi: api, port: 0, secret: 's3cret' });
  try {
    const base = `http://127.0.0.1:${src.port}`;

    // healthz
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    // 没带密钥 → 401
    const noSecret = await fetch(`${base}/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '记 买花生' }),
    });
    assert.equal(noSecret.status, 401);

    // 带密钥 → 200，笔记自动落库（notes 规则，confirm:never）
    const ok = await fetch(`${base}/ingest/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lifeos-secret': 's3cret' },
      body: JSON.stringify({ text: '记 买花生', source_ref: 'wh-1' }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.status, 'committed');
    assert.equal(body.route.intent, 'notes.add_note');

    const notes = await store.entities.list({ type: 'note' });
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, '买花生');
  } finally {
    await src.close();
    await store.close();
  }
});

test('watch-folder source: new .txt ingests once; rescan is a no-op', async () => {
  const store = await freshStore();
  const api = capture(store);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifeos-watch-'));
  try {
    await fs.writeFile(path.join(dir, 'memo.txt'), '记 给宝宝补维生素D');
    const watcher = watchFolder({ captureApi: api, dir });

    const first = await watcher.scanOnce();
    assert.equal(first.length, 1);
    assert.equal(first[0].file, 'memo.txt');
    assert.equal(first[0].status, 'committed'); // notes 规则命中 → 自动落库

    const cap = await store.entities.get(first[0].id);
    assert.equal(cap.source, 'watch-folder');
    assert.match(cap.source_ref, /^file:memo\.txt:/);
    assert.equal(cap.data.kind, 'text');

    // 第二次扫描：mtime 没变 → 不重复入站
    const second = await watcher.scanOnce();
    assert.equal(second.length, 0);
    assert.equal((await store.entities.list({ type: 'capture' })).length, 1);

    // 图片文件 → photo Capture，media 存引用（vision 路由是 P2，这里结构先就位）
    await fs.writeFile(path.join(dir, 'shelf.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const third = await watcher.scanOnce();
    assert.equal(third.length, 1);
    const photoCap = await store.entities.get(third[0].id);
    assert.equal(photoCap.data.kind, 'photo');
    assert.equal(photoCap.data.media.length, 1);
    assert.equal(photoCap.data.media[0].mime, 'image/png');
    assert.equal(third[0].status, 'pending'); // 无文本无规则 → 等人工/vision
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await store.close();
  }
});
