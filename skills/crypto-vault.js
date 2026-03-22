/**
 * 敏感字段落盘加密（AES-256-GCM）。密钥仅来自环境变量，不入库。
 * 设置：HOUSEHOLD_ENCRYPTION_KEY = 64 位十六进制（32 字节），例如：
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LEN = 16;

function getKeyBuf() {
  const raw = process.env.HOUSEHOLD_ENCRYPTION_KEY;
  if (!raw || !String(raw).trim()) return null;
  const hex = String(raw).trim();
  try {
    const buf = Buffer.from(hex, "hex");
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

function encryptionEnabled() {
  return getKeyBuf() !== null;
}

/**
 * @returns {{ v: number, algo: string, iv: string, tag: string, ct: string }}
 */
function encryptSecret(plaintext) {
  const key = getKeyBuf();
  if (!key) {
    const err = new Error("未配置 HOUSEHOLD_ENCRYPTION_KEY，无法加密存储");
    err.code = "NO_ENCRYPTION_KEY";
    throw err;
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    algo: ALGO,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: enc.toString("base64"),
  };
}

function decryptSecret(vault) {
  const key = getKeyBuf();
  if (!key || !vault || typeof vault !== "object" || !vault.ct) return null;
  try {
    const iv = Buffer.from(vault.iv, "base64");
    const tag = Buffer.from(vault.tag, "base64");
    const ciphertext = Buffer.from(vault.ct, "base64");
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function stripVaultForClient(item) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  if (out.encrypted_vault) {
    delete out.encrypted_vault;
    out.has_encrypted_secret = true;
  }
  return out;
}

module.exports = {
  encryptionEnabled,
  encryptSecret,
  decryptSecret,
  stripVaultForClient,
};
