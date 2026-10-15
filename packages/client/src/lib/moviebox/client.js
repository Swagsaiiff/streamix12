// MovieBox HTTP Client with host rotation, request signing, and CORS proxy support

import { buildSignedHeaders, generateClientInfoAndUA } from "./crypto.js";
import { loadSession, saveSession, clearSession, MovieBoxSession } from "./session.js";

export const HOST_POOL = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api4sg.aoneroom.com",
  "https://api3.aoneroom.com",
  "https://api6sg.aoneroom.com",
  "https://api.inmoviebox.com"
];

const RETRY_STATUS_CODES = [401, 403, 406, 407, 429, 500, 502, 503, 504];

let activeHostIndex = 0;
let clientIdentity = null;

function getClientIdentity() {
  if (!clientIdentity) {
    clientIdentity = generateClientInfoAndUA();
  }
  return clientIdentity;
}

export function buildProxiedUrl(targetUrl, proxyBase = null) {
  // If explicitly provided or running in browser with CORS restrictions:
  const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";

  // Priority 1: Custom proxy override (e.g. from env or options)
  if (proxyBase) {
    if (proxyBase.includes("%s")) {
      return proxyBase.replace("%s", encodeURIComponent(targetUrl));
    }
    return `${proxyBase.replace(/\/?$/, "/")}${encodeURIComponent(targetUrl)}`;
  }

  // Priority 2: In Vite dev mode, we can use the local dev proxy if available, but
  // standard corsproxy.io works reliably for external browser requests.
  if (isBrowser) {
    // We use corsproxy.io as requested: https://corsproxy.io/?url=
    return `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
  }

  // Direct for Node.js / test environments
  return targetUrl;
}

export class MovieBoxClient {
  constructor(options = {}) {
    this.corsProxy = options.corsProxy || null;
    this.useProxy = options.useProxy ?? (typeof window !== "undefined");
    this.session = null;
    this.identity = getClientIdentity();
  }

  async ensureSession(signal) {
    const existing = loadSession();
    if (existing && existing.isValid()) {
      this.session = existing;
      return existing.token;
    }

    const freshSession = await this.visitorLogin(signal);
    this.session = freshSession;
    saveSession(freshSession);
    return freshSession.token;
  }

  async visitorLogin(signal) {
    const path = "/wefeed-mobile-bff/user-api/visitor-login";
    const bodyStr = "{}";

    const res = await this.requestHosts("POST", path, bodyStr, null, { signal, isLogin: true });

    const token = res.token || res.data?.token;
    if (!token) {
      throw new Error("MovieBox visitor login failed: no token returned");
    }

    const uid = res.uid || res.userId || res.data?.uid || res.data?.userId;
    return MovieBoxSession.fromToken(token, uid ? String(uid) : null);
  }

  invalidateSession() {
    this.session = null;
    clearSession();
  }

  async get(pathAndQuery, options = {}) {
    return this.request("GET", pathAndQuery, null, options);
  }

  async post(pathAndQuery, body, options = {}) {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    return this.request("POST", pathAndQuery, bodyStr, options);
  }

  async request(method, pathAndQuery, bodyStr, options = {}) {
    let token = null;
    if (!options.isLogin) {
      token = await this.ensureSession(options.signal);
    }

    try {
      return await this.requestHosts(method, pathAndQuery, bodyStr, token, options);
    } catch (err) {
      // If 401 or 403, retry once with fresh session
      if (err.status === 401 || err.status === 403 || err.message?.includes("token")) {
        this.invalidateSession();
        token = await this.ensureSession(options.signal);
        return await this.requestHosts(method, pathAndQuery, bodyStr, token, options);
      }
      throw err;
    }
  }

  async requestHosts(method, pathAndQuery, bodyStr, authToken, options = {}) {
    const startIdx = activeHostIndex;
    let lastError = null;

    for (let i = 0; i < HOST_POOL.length; i++) {
      if (options.signal?.aborted) {
        throw new Error("MovieBox request aborted");
      }

      const idx = (startIdx + i) % HOST_POOL.length;
      const baseHost = HOST_POOL[idx];
      const targetUrl = `${baseHost}${pathAndQuery}`;

      const headers = buildSignedHeaders({
        method,
        url: targetUrl,
        body: bodyStr,
        authToken,
        userAgent: this.identity.userAgent,
        clientInfo: this.identity.clientInfo,
        spoofedIp: this.identity.spoofedIp
      });

      // Wrap in CORS proxy if browser or enabled
      const fetchUrl = this.useProxy
        ? buildProxiedUrl(targetUrl, this.corsProxy)
        : targetUrl;

      try {
        const fetchOptions = {
          method,
          headers,
          signal: options.signal
        };
        if (bodyStr != null) {
          fetchOptions.body = bodyStr;
        }

        const resp = await fetch(fetchUrl, fetchOptions);

        if (RETRY_STATUS_CODES.includes(resp.status)) {
          lastError = new Error(`MovieBox host ${baseHost} returned HTTP ${resp.status}`);
          lastError.status = resp.status;
          activeHostIndex = (idx + 1) % HOST_POOL.length;
          continue;
        }

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          lastError = new Error(`MovieBox request failed with HTTP ${resp.status}: ${text.slice(0, 100)}`);
          lastError.status = resp.status;
          activeHostIndex = (idx + 1) % HOST_POOL.length;
          continue;
        }

        const rawText = await resp.text();
        let json;
        try {
          json = JSON.parse(rawText);
        } catch {
          lastError = new Error(`MovieBox host ${baseHost} returned non-JSON response`);
          activeHostIndex = (idx + 1) % HOST_POOL.length;
          continue;
        }

        activeHostIndex = idx;
        return json.data !== undefined ? json.data : json;
      } catch (err) {
        if (err.name === "AbortError" || options.signal?.aborted) {
          throw err;
        }
        lastError = err;
        activeHostIndex = (idx + 1) % HOST_POOL.length;
      }
    }

    throw lastError || new Error("All MovieBox hosts exhausted");
  }
}

export const defaultMovieBoxClient = new MovieBoxClient();
