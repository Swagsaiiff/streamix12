// MovieBox visitor session and token manager

const SESSION_STORAGE_KEY = "streamix_moviebox_session";

export function parseJwtClaims(token) {
  if (!token || typeof token !== "string") return { uid: null, exp: null };
  const parts = token.split(".");
  if (parts.length < 2) return { uid: null, exp: null };

  let payloadB64 = parts[1];
  const padLen = (4 - (payloadB64.length % 4)) % 4;
  if (padLen > 0) {
    payloadB64 += "=".repeat(padLen);
  }

  // Base64url to base64
  const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");

  try {
    let jsonStr = "";
    if (typeof atob === "function") {
      jsonStr = atob(normalized);
    } else {
      jsonStr = Buffer.from(normalized, "base64").toString("utf8");
    }
    const val = JSON.parse(jsonStr);
    const uid = val.userId || val.uid || val.sub || null;
    let exp = null;
    if (typeof val.exp === "number") {
      exp = val.exp;
    } else if (typeof val.exp === "string") {
      const parsed = parseInt(val.exp, 10);
      if (!Number.isNaN(parsed)) exp = parsed;
    }
    return { uid: uid != null ? String(uid) : null, exp };
  } catch {
    return { uid: null, exp: null };
  }
}

export class MovieBoxSession {
  constructor(token, userId = null, expiresAt = null, createdAt = null) {
    this.token = token || "";
    this.userId = userId || null;
    this.expiresAt = expiresAt || null;
    this.createdAt = createdAt || Math.floor(Date.now() / 1000);
  }

  static fromToken(token, explicitUid = null) {
    const { uid, exp } = parseJwtClaims(token);
    return new MovieBoxSession(token, explicitUid || uid, exp);
  }

  isValid() {
    if (!this.token || !this.token.trim()) return false;
    const now = Math.floor(Date.now() / 1000);
    if (this.expiresAt) {
      // Must have at least 60 seconds remaining
      return now + 60 < this.expiresAt;
    }
    // Default 7 days
    return now < this.createdAt + 7 * 24 * 3600;
  }
}

let inMemorySession = null;

export function loadSession() {
  if (inMemorySession && inMemorySession.isValid()) {
    return inMemorySession;
  }

  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const session = new MovieBoxSession(
          parsed.token,
          parsed.userId,
          parsed.expiresAt,
          parsed.createdAt
        );
        if (session.isValid()) {
          inMemorySession = session;
          return session;
        }
      }
    }
  } catch {
    // localStorage may be unavailable or disabled
  }

  return null;
}

export function saveSession(session) {
  inMemorySession = session;
  try {
    if (typeof localStorage !== "undefined" && session) {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          token: session.token,
          userId: session.userId,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt
        })
      );
    }
  } catch {
    // ignore
  }
}

export function clearSession() {
  inMemorySession = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}
