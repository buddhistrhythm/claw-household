'use strict';

/**
 * crypto.js — AES-256-GCM 字段级加密小工具 (field-level encryption helper).
 *
 * 加密策略 / encryption strategy
 * ──────────────────────────────────────────────────────────────────────────
 * lifeos 是 "document + relations" 存储：全文检索、SQL 聚合 (data->>'...')、
 * 以及知识图谱都依赖明文。所以我们 **不** 整条记录加密，而是分两类字段：
 *
 *   · 可检索字段保持明文 (searchable PLAINTEXT)：金额、币种、品类、收支方向、
 *     商户、入账日期、账户类型/机构 — 留在列 / `data` 里，检索与聚合照常工作。
 *   · 敏感字段加密成单个不透明 blob (sensitive → opaque `data.enc`)：账号 /
 *     last4、交易备注 memo、银行原始描述 raw descriptor。
 *
 * 取舍 / key-loss tradeoff：
 *   `data.enc` 是一个用主密钥派生的 AES-256-GCM 令牌。**丢失密钥只丢失这个
 *   blob**（敏感字段无法解密），其余可检索数据与图谱完好无损 —— 这是设计意图，
 *   不是 bug。密钥从不写入数据库或 Obsidian 镜像。
 *
 * 令牌格式 / token formats：
 *   有密钥 (key present)：  `enc:v1:<base64( iv(12) | authTag(16) | ciphertext )>`
 *   无密钥 (dev, no key)：  `plain:v1:<base64(json)>`   ← 明确标记为未加密
 *
 * 密钥 lazily 从 process.env.LIFEOS_SECRET_KEY 在 **每次调用时** 读取（方便测试
 * 切换），再用 scryptSync(secret, 'lifeos.kdf.v1', 32) 派生 32 字节密钥。
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KDF_SALT = 'lifeos.kdf.v1'; // 固定 salt：派生稳定密钥 (deterministic key)
const IV_LEN = 12;               // GCM 推荐 96-bit IV
const TAG_LEN = 16;              // GCM auth tag 128-bit

const ENC_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:v1:';

/** 读取原始密钥（每次调用都读，便于测试切换）。 */
function rawSecret() {
  const s = process.env.LIFEOS_SECRET_KEY;
  return s && s.length ? s : null;
}

/** 是否已配置密钥 / whether a key is configured. */
function isEnabled() {
  return rawSecret() !== null;
}

/** scryptSync 派生 32 字节 AES 密钥。 */
function deriveKey(secret) {
  return crypto.scryptSync(secret, KDF_SALT, 32);
}

/**
 * encrypt(value) -> token string.
 * value 可为字符串或可 JSON 序列化的对象；内部统一以 JSON 编码。
 */
function encrypt(value) {
  const json = JSON.stringify(value);
  const secret = rawSecret();
  if (!secret) {
    // 无密钥的开发态：明文标记，系统仍可工作 (clearly marked unencrypted).
    return PLAIN_PREFIX + Buffer.from(json, 'utf8').toString('base64');
  }
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * decrypt(token) -> original value (JSON 反序列化回对象/字符串)。
 * 同时支持 enc: / plain:；若是 enc: 令牌但未配置密钥则抛清晰错误。
 */
function decrypt(token) {
  if (typeof token !== 'string') throw new Error('crypto.decrypt: token must be a string');

  if (token.startsWith(PLAIN_PREFIX)) {
    const json = Buffer.from(token.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
    return JSON.parse(json);
  }

  if (token.startsWith(ENC_PREFIX)) {
    const secret = rawSecret();
    if (!secret) {
      throw new Error('crypto.decrypt: encrypted token present but LIFEOS_SECRET_KEY is not set (key lost?)');
    }
    const buf = Buffer.from(token.slice(ENC_PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  }

  throw new Error('crypto.decrypt: unrecognized token format (expected enc:v1: or plain:v1:)');
}

module.exports = { isEnabled, encrypt, decrypt };
