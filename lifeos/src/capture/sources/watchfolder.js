'use strict';

/**
 * capture/sources/watchfolder.js — 监听目录 Source（poll 型入站适配器）.
 *
 * 典型用法（SPEC §4·B）：眼镜/手机照片同步到某目录 → 这里轮询发现新文件 →
 * 变成 photo/text Capture 喂进管线。用 fs.readdir + mtime 轮询而非 fs.watch
 * （跨平台/网络盘可靠性 / portability）。source_ref 含内容 sha → 重启后天然去重。
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function watchFolder({ captureApi, dir, intervalMs = 5000, exts = ['.jpg', '.jpeg', '.png', '.txt', '.md'] } = {}) {
  if (!captureApi || !dir) throw new Error('watchFolder: `captureApi` and `dir` are required');
  const seen = new Map(); // 文件名 → mtimeMs（进程内缓存；跨重启靠 source_ref 去重）
  let timer = null;

  /** 单次扫描（测试用这个，不开定时器）。返回本次入站结果列表。 */
  async function scanOnce() {
    const results = [];
    const names = await fsp.readdir(dir);
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!exts.includes(ext)) continue;
      const abs = path.join(dir, name);
      let st;
      try { st = await fsp.stat(abs); } catch { continue; } // 扫描间隙被删了 → 跳过
      if (!st.isFile()) continue;
      if (seen.get(name) === st.mtimeMs) continue; // 没变化 → 跳过

      const content = await fsp.readFile(abs);
      const sha = sha1(content).slice(0, 12);
      const isImage = !!IMAGE_MIME[ext];
      const out = await captureApi.ingest({
        channel: 'watch-folder',
        kind: isImage ? 'photo' : 'text',
        source_ref: `file:${name}:${sha}`, // 名字+内容指纹 = 稳定去重键
        text: isImage ? '' : content.toString('utf8'),
        media: isImage ? [{ ref: abs, mime: IMAGE_MIME[ext], sha }] : [],
      });
      seen.set(name, st.mtimeMs);
      results.push({ file: name, ...out });
    }
    return results;
  }

  return {
    scanOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => { scanOnce().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref(); // 不阻止进程退出
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = { watchFolder };
