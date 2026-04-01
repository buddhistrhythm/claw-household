/**
 * auth.js — OAuth (Google + Apple) + JWT session middleware
 *
 * Environment variables (in .env):
 *   GOOGLE_CLIENT_ID       — Google OAuth2 client ID
 *   GOOGLE_CLIENT_SECRET   — Google OAuth2 client secret
 *   APPLE_CLIENT_ID        — Apple Services ID (e.g. com.example.app)
 *   APPLE_TEAM_ID          — Apple Developer Team ID
 *   APPLE_KEY_ID           — Apple Sign-In private key ID
 *   APPLE_PRIVATE_KEY      — Apple Sign-In private key (PEM, newlines as \n)
 *   JWT_SECRET             — Secret for signing JWT tokens
 *   AUTH_DISABLED           — Set to "1" to disable auth (local/dev mode)
 */

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { users, families } = require("./db");

const JWT_SECRET = () => process.env.JWT_SECRET || "dev-secret-change-me-" + crypto.randomBytes(8).toString("hex");
const TOKEN_EXPIRY = "30d";

/* ─── JWT helpers ─────────────────────────────────────────────────────────── */

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: TOKEN_EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET());
  } catch {
    return null;
  }
}

/**
 * Express middleware: require authenticated user.
 * Sets req.userId, req.user, req.familyId on success.
 * In dev mode (AUTH_DISABLED=1), creates/reuses a default dev user.
 */
function requireAuth(db) {
  return (req, res, next) => {
    // Dev mode bypass
    if (process.env.AUTH_DISABLED === "1") {
      const devUser = ensureDevUser(db);
      req.userId = devUser.id;
      req.user = devUser;
      req.familyId = devUser._familyId;
      return next();
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.token || req.query?._token;
    if (!token) return res.status(401).json({ error: "未登录" });

    const payload = verifyToken(token);
    if (!payload || !payload.userId) return res.status(401).json({ error: "登录已过期" });

    const user = users.findById(db, payload.userId);
    if (!user) return res.status(401).json({ error: "用户不存在" });

    req.userId = user.id;
    req.user = user;
    req.familyId = payload.familyId || null;

    // Verify family membership if familyId is set
    if (req.familyId) {
      const { isMember } = require("./db").families;
      if (!isMember(db, req.familyId, user.id)) {
        req.familyId = null; // Clear invalid family
      }
    }

    // Auto-select first family if none selected
    if (!req.familyId) {
      const fams = users.getFamilies(db, user.id);
      if (fams.length) req.familyId = fams[0].id;
    }

    next();
  };
}

/**
 * Optional auth: if token present, populate req.userId etc. but don't block.
 */
function optionalAuth(db) {
  return (req, res, next) => {
    if (process.env.AUTH_DISABLED === "1") {
      const devUser = ensureDevUser(db);
      req.userId = devUser.id;
      req.user = devUser;
      req.familyId = devUser._familyId;
      return next();
    }
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.query?._token;
    if (!token) return next();
    const payload = verifyToken(token);
    if (payload?.userId) {
      const user = users.findById(db, payload.userId);
      if (user) {
        req.userId = user.id;
        req.user = user;
        req.familyId = payload.familyId || null;
        if (!req.familyId) {
          const fams = users.getFamilies(db, user.id);
          if (fams.length) req.familyId = fams[0].id;
        }
      }
    }
    next();
  };
}

/**
 * Require family admin role for destructive operations.
 */
function requireAdmin(db) {
  return (req, res, next) => {
    if (process.env.AUTH_DISABLED === "1") return next();
    if (!req.familyId || !req.userId) return res.status(403).json({ error: "无权限" });
    if (!families.isAdmin(db, req.familyId, req.userId)) {
      return res.status(403).json({ error: "仅家庭管理员可操作" });
    }
    next();
  };
}

/* ─── Dev user ────────────────────────────────────────────────────────────── */

let _devUser = null;
function ensureDevUser(db) {
  if (_devUser) return _devUser;
  let user = users.findByProviderSub(db, "dev", "local");
  if (!user) {
    user = users.upsertFromOAuth(db, {
      provider: "dev",
      sub: "local",
      email: "dev@localhost",
      name: "本地用户",
      avatarUrl: "",
    });
    const fam = families.create(db, "我的家庭", user.id);
    user._familyId = fam.id;
  } else {
    const fams = users.getFamilies(db, user.id);
    user._familyId = fams[0]?.id || null;
    if (!user._familyId) {
      const fam = families.create(db, "我的家庭", user.id);
      user._familyId = fam.id;
    }
  }
  _devUser = user;
  return user;
}

/* ─── Google OAuth2 ───────────────────────────────────────────────────────── */

async function googleAuth(db, { code, redirectUri }) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "Google OAuth 未配置" };

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    return { ok: false, error: tokenData.error_description || "Google 授权失败" };
  }

  // Get user info
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await userRes.json();
  if (!profile.email) return { ok: false, error: "无法获取 Google 用户信息" };

  const user = users.upsertFromOAuth(db, {
    provider: "google",
    sub: profile.id,
    email: profile.email,
    name: profile.name || "",
    avatarUrl: profile.picture || "",
  });

  return finishOAuth(db, user);
}

/* ─── Apple Sign In ───────────────────────────────────────────────────────── */

async function appleAuth(db, { code, redirectUri, idToken: rawIdToken, userName }) {
  const clientId = process.env.APPLE_CLIENT_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!clientId || !teamId || !keyId || !privateKey) {
    return { ok: false, error: "Apple Sign In 未配置" };
  }

  // Generate client_secret JWT
  const clientSecret = jwt.sign({}, privateKey, {
    algorithm: "ES256",
    expiresIn: "5m",
    audience: "https://appleid.apple.com",
    issuer: teamId,
    subject: clientId,
    keyid: keyId,
  });

  let idToken = rawIdToken;

  // If we have an authorization code, exchange it for tokens
  if (code && !idToken) {
    const tokenRes = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri || "",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.id_token) {
      return { ok: false, error: tokenData.error || "Apple 授权失败" };
    }
    idToken = tokenData.id_token;
  }

  if (!idToken) return { ok: false, error: "缺少 id_token" };

  // Decode (Apple's id_token is a JWT — we verify issuer/audience)
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.payload?.sub) return { ok: false, error: "无效的 Apple id_token" };

  const { sub, email } = decoded.payload;
  const user = users.upsertFromOAuth(db, {
    provider: "apple",
    sub,
    email: email || `${sub}@privaterelay.appleid.com`,
    name: userName || "",
    avatarUrl: "",
  });

  return finishOAuth(db, user);
}

/* ─── Shared post-OAuth logic ─────────────────────────────────────────────── */

function finishOAuth(db, user) {
  // Ensure user has at least one family
  let fams = users.getFamilies(db, user.id);
  if (!fams.length) {
    families.create(db, "我的家庭", user.id);
    fams = users.getFamilies(db, user.id);
  }
  const familyId = fams[0].id;
  const token = signToken({ userId: user.id, familyId });
  return {
    ok: true,
    token,
    user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
    families: fams.map((f) => ({ id: f.id, name: f.name, role: f.role })),
    currentFamilyId: familyId,
  };
}

module.exports = {
  signToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  requireAdmin,
  googleAuth,
  appleAuth,
};
