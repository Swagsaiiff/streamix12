import crypto from "node:crypto";
import { Readable } from "node:stream";
import { logger } from "../logger.js";

// In-memory registry associating secure stream tokens with resolved upstream URLs and protected headers.
// Keeps cookies, tokens, and provider headers server-side and never exposes them to the browser.
const streamRegistry = new Map();
const STREAM_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function registerStreamToken({ url, headers = {}, provider = null }) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();

  // Clean up expired tokens periodically
  if (streamRegistry.size > 200) {
    for (const [key, entry] of streamRegistry.entries()) {
      if (now - entry.createdAt > STREAM_TOKEN_TTL_MS) {
        streamRegistry.delete(key);
      }
    }
  }

  streamRegistry.set(token, {
    url,
    headers: { ...headers },
    provider,
    createdAt: now
  });

  return token;
}

export function getStreamByToken(token) {
  if (!token || typeof token !== "string") return null;
  const entry = streamRegistry.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > STREAM_TOKEN_TTL_MS) {
    streamRegistry.delete(token);
    return null;
  }
  return entry;
}

export function clearStreamTokens() {
  streamRegistry.clear();
}

// Approved host patterns for media providers and CDNs
const ALLOWED_HOST_PATTERN =
  /^(?:[a-zA-Z0-9-]+\.)*(?:r2\.cloudflarestorage\.com|r2\.dev|pixeldrain\.(?:com|dev)|hubcloud\.[a-z0-9-]+|vcloud\.[a-z0-9-]+|fastdl\.[a-z0-9-]+|nexdrive\.[a-z0-9-]+|filebee\.[a-z0-9-]+|vegadrive\.[a-z0-9-]+|gofile\.[a-z0-9-]+|gdflix\.[a-z0-9-]+|hubdrive\.[a-z0-9-]+|driveseed\.[a-z0-9-]+|driveleech\.[a-z0-9-]+|drivebot\.[a-z0-9-]+|gpdl\d*\.[a-z0-9-]+|vegamovies\.[a-z0-9-]+)$/i;

// Match private, loopback, link-local, carrier-grade NAT, or test addresses
export function isPrivateOrLocalHost(hostname) {
  if (!hostname || typeof hostname !== "string") return true;
  const host = hostname.trim().toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    host.endsWith(".lan")
  ) {
    return true;
  }

  // IPv4 checks
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    return false;
  }

  // Pure numeric / hex / octal IP formats (e.g. 2130706433, 0x7f000001)
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(host)) {
    return true;
  }

  // IPv6 checks (including bracketed [::1])
  const cleanIpv6 = host.replace(/^\[|\]$/g, "");
  if (
    cleanIpv6 === "::1" ||
    cleanIpv6 === "::" ||
    cleanIpv6.startsWith("fe80:") || // link-local
    cleanIpv6.startsWith("fc") ||
    cleanIpv6.startsWith("fd") || // unique local
    cleanIpv6.startsWith("::ffff:") // IPv4 mapped
  ) {
    return true;
  }

  return false;
}

export function isAllowedHost(hostname) {
  if (!hostname || typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase();
  if (isPrivateOrLocalHost(host)) return false;
  return ALLOWED_HOST_PATTERN.test(host);
}

export function validateProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { valid: false, status: 400, reason: "Missing or invalid 'url' query parameter" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, status: 400, reason: "Malformed media URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, status: 400, reason: "Only HTTP and HTTPS media URLs are permitted" };
  }

  const host = parsed.hostname;
  if (isPrivateOrLocalHost(host)) {
    return { valid: false, status: 403, reason: "Access to private or local network hosts is forbidden" };
  }

  if (!isAllowedHost(host)) {
    return {
      valid: false,
      status: 403,
      reason: `Host '${host}' is not on the approved provider or CDN domain allowlist`
    };
  }

  return { valid: true, url: parsed };
}

const MAX_REDIRECTS = 3;

export async function proxyMediaRequest(req, res) {
  // CORS Preflight and access control headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Accept, User-Agent, Referer");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, Accept-Ranges, Content-Type, ETag, Last-Modified"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  let targetUrl = null;
  let serverHeaders = {};

  if (req.query.token) {
    const tokenRecord = getStreamByToken(req.query.token);
    if (!tokenRecord) {
      return res.status(404).json({
        error: "proxy_error",
        message: "Stream session token not found or expired"
      });
    }
    targetUrl = tokenRecord.url;
    serverHeaders = { ...tokenRecord.headers };
  } else if (req.query.url) {
    targetUrl = req.query.url;
  } else {
    return res.status(400).json({
      error: "proxy_error",
      message: "Missing 'token' or 'url' query parameter"
    });
  }

  const validation = validateProxyUrl(targetUrl);
  if (!validation.valid) {
    logger.warn("media_proxy.rejected", { url: targetUrl, reason: validation.reason, status: validation.status });
    return res.status(validation.status).json({
      error: "proxy_error",
      message: validation.reason
    });
  }

  let currentUrl = validation.url.href;
  let redirects = 0;
  const clientAbortController = new AbortController();

  // Downstream disconnect detection:
  // res emits "close" when the connection terminates.
  // Abort only when res.writableEnded is false (i.e. client prematurely closed socket before response finished).
  res.on("close", () => {
    if (!res.writableEnded) {
      clientAbortController.abort();
    }
  });
  res.on("error", () => {
    clientAbortController.abort();
  });

  try {
    let upstreamRes = null;

    while (redirects <= MAX_REDIRECTS) {
      // Start with server-stored headers (e.g. Referer, cookies) without exposing them to browser
      const headers = { ...serverHeaders };

      if (req.headers["range"]) {
        headers["Range"] = req.headers["range"];
      }
      if (req.headers["accept"]) {
        headers["Accept"] = req.headers["accept"];
      }
      if (!headers["User-Agent"]) {
        headers["User-Agent"] =
          req.headers["user-agent"] ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      }

      if (req.query.referer && !headers["Referer"]) {
        headers["Referer"] = req.query.referer;
      }

      upstreamRes = await fetch(currentUrl, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers,
        redirect: "manual",
        signal: clientAbortController.signal
      });

      // Handle redirects securely
      if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
        redirects++;
        if (redirects > MAX_REDIRECTS) {
          logger.warn("media_proxy.too_many_redirects", { url: currentUrl });
          return res.status(502).json({ error: "proxy_error", message: "Too many upstream redirects" });
        }

        const location = upstreamRes.headers.get("location");
        if (!location) {
          return res.status(502).json({ error: "proxy_error", message: "Upstream redirect missing Location header" });
        }

        let nextUrl;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch {
          return res.status(502).json({ error: "proxy_error", message: "Invalid upstream redirect URL" });
        }

        const redirectValidation = validateProxyUrl(nextUrl);
        if (!redirectValidation.valid) {
          logger.warn("media_proxy.redirect_rejected", {
            from: currentUrl,
            to: nextUrl,
            reason: redirectValidation.reason
          });
          return res.status(403).json({
            error: "proxy_error",
            message: `Redirect to unapproved host: ${redirectValidation.reason}`
          });
        }

        currentUrl = nextUrl;
        continue;
      }

      break;
    }

    if (!upstreamRes) {
      return res.status(502).json({ error: "proxy_error", message: "Failed to connect to upstream media host" });
    }

    // Forward status code (e.g. 206 Partial Content, 200 OK, 304, 404, 410)
    res.status(upstreamRes.status);

    // Forward relevant media response headers
    const forwardHeaders = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "content-disposition",
      "etag",
      "last-modified"
    ];

    for (const h of forwardHeaders) {
      const val = upstreamRes.headers.get(h);
      if (val !== null && val !== undefined) {
        res.setHeader(h, val);
      }
    }

    // Ensure Accept-Ranges is advertised
    if (!res.getHeader("accept-ranges") && (upstreamRes.status === 200 || upstreamRes.status === 206)) {
      res.setHeader("accept-ranges", "bytes");
    }

    if (req.method === "HEAD") {
      return res.end();
    }

    // Stream the body without buffering in server memory
    if (upstreamRes.body) {
      const nodeStream = Readable.fromWeb(upstreamRes.body);
      nodeStream.on("error", (err) => {
        logger.warn("media_proxy.stream_error", { error: err.message });
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.destroy();
        }
      });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err.name === "AbortError" || clientAbortController.signal.aborted) {
      return; // Client cancelled / disconnected
    }
    logger.error("media_proxy.upstream_error", {
      url: currentUrl,
      error: err.message
    });
    if (!res.headersSent) {
      res.status(502).json({
        error: "proxy_error",
        message: `Upstream media request failed: ${err.message}`
      });
    } else {
      res.destroy();
    }
  }
}
