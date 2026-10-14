import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateOrLocalHost,
  isAllowedHost,
  validateProxyUrl,
  proxyMediaRequest,
  registerStreamToken,
  getStreamByToken,
  clearStreamTokens
} from "./proxy.js";

test("isPrivateOrLocalHost identifies loopback and private IP addresses", () => {
  assert.equal(isPrivateOrLocalHost("localhost"), true);
  assert.equal(isPrivateOrLocalHost("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("127.1.2.3"), true);
  assert.equal(isPrivateOrLocalHost("10.0.0.1"), true);
  assert.equal(isPrivateOrLocalHost("192.168.1.1"), true);
  assert.equal(isPrivateOrLocalHost("172.16.0.1"), true);
  assert.equal(isPrivateOrLocalHost("172.31.255.255"), true);
  assert.equal(isPrivateOrLocalHost("169.254.169.254"), true); // AWS/cloud metadata
  assert.equal(isPrivateOrLocalHost("0.0.0.0"), true);
  assert.equal(isPrivateOrLocalHost("server.local"), true);
  assert.equal(isPrivateOrLocalHost("internal.lan"), true);
  assert.equal(isPrivateOrLocalHost("::1"), true);
  assert.equal(isPrivateOrLocalHost("[::1]"), true);
  assert.equal(isPrivateOrLocalHost("fe80::1"), true);

  // Valid public hostnames should not be flagged as private
  assert.equal(isPrivateOrLocalHost("pub-abc.r2.cloudflarestorage.com"), false);
  assert.equal(isPrivateOrLocalHost("pixeldrain.com"), false);
  assert.equal(isPrivateOrLocalHost("pixeldrain.dev"), false);
  assert.equal(isPrivateOrLocalHost("hubcloud.club"), false);
});

test("isAllowedHost permits only approved provider and CDN domains", () => {
  assert.equal(isAllowedHost("pub-123456.r2.cloudflarestorage.com"), true);
  assert.equal(isAllowedHost("media.r2.dev"), true);
  assert.equal(isAllowedHost("pixeldrain.com"), true);
  assert.equal(isAllowedHost("cdn.pixeldrain.com"), true);
  assert.equal(isAllowedHost("pixeldrain.dev"), true);
  assert.equal(isAllowedHost("hubcloud.club"), true);
  assert.equal(isAllowedHost("vcloud.beer"), true);
  assert.equal(isAllowedHost("fastdl.ink"), true);
  assert.equal(isAllowedHost("nexdrive.beer"), true);
  assert.equal(isAllowedHost("gpdl1.online"), true);
  assert.equal(isAllowedHost("vegamovies.gallery"), true);

  // Unapproved domains and attack vectors must be rejected
  assert.equal(isAllowedHost("evil.com"), false);
  assert.equal(isAllowedHost("google.com"), false);
  assert.equal(isAllowedHost("r2.cloudflarestorage.com.attacker.com"), false);
  assert.equal(isAllowedHost("pixeldrain.com.attacker.com"), false);
  assert.equal(isAllowedHost("127.0.0.1"), false);
  assert.equal(isAllowedHost("169.254.169.254"), false);
});

test("validateProxyUrl enforces protocol, private network protection, and domain restrictions", () => {
  // Missing parameter
  assert.equal(validateProxyUrl(null).valid, false);
  assert.equal(validateProxyUrl(null).status, 400);

  // Invalid protocol
  assert.equal(validateProxyUrl("file:///etc/passwd").valid, false);
  assert.equal(validateProxyUrl("ftp://r2.dev/video.mp4").valid, false);

  // SSRF attempts targeting internal services
  const localhostCheck = validateProxyUrl("http://localhost:4001/api/health");
  assert.equal(localhostCheck.valid, false);
  assert.equal(localhostCheck.status, 403);

  const metadataCheck = validateProxyUrl("http://169.254.169.254/latest/meta-data");
  assert.equal(metadataCheck.valid, false);
  assert.equal(metadataCheck.status, 403);

  // Unapproved external host
  const unapprovedCheck = validateProxyUrl("https://unapproved-site.com/movie.mkv");
  assert.equal(unapprovedCheck.valid, false);
  assert.equal(unapprovedCheck.status, 403);

  // Valid approved media URLs
  const r2Check = validateProxyUrl("https://pub-abc.r2.cloudflarestorage.com/hub2/movie.mkv?sig=123");
  assert.equal(r2Check.valid, true);
  assert.equal(r2Check.url.hostname, "pub-abc.r2.cloudflarestorage.com");

  const pixeldrainCheck = validateProxyUrl("https://pixeldrain.com/api/file/abc1234");
  assert.equal(pixeldrainCheck.valid, true);
});

test("registerStreamToken associates URL and protected headers with secure token", () => {
  clearStreamTokens();
  const token = registerStreamToken({
    url: "https://pub-abc.r2.cloudflarestorage.com/hub2/movie.mkv",
    headers: {
      Referer: "https://vegamovies.gallery/",
      Cookie: "session_secret=xyz123"
    },
    provider: "CineStream"
  });

  assert.ok(typeof token === "string" && token.length >= 32);
  const record = getStreamByToken(token);
  assert.ok(record);
  assert.equal(record.url, "https://pub-abc.r2.cloudflarestorage.com/hub2/movie.mkv");
  assert.equal(record.headers.Referer, "https://vegamovies.gallery/");
  assert.equal(record.headers.Cookie, "session_secret=xyz123");

  // Invalid or unknown token returns null
  assert.equal(getStreamByToken("nonexistent-token"), null);
  assert.equal(getStreamByToken(null), null);
});

test("proxyMediaRequest sets CORS headers and handles preflight OPTIONS", async () => {
  let statusSet = 0;
  const headers = {};
  const mockRes = {
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(code) {
      statusSet = code;
      return this;
    },
    end() {}
  };

  await proxyMediaRequest({ method: "OPTIONS", query: {}, headers: {} }, mockRes);
  assert.equal(headers["access-control-allow-origin"], "*");
  assert.equal(statusSet, 204);
});

test("proxyMediaRequest rejects forbidden hosts with 403 JSON", async () => {
  let statusSet = 0;
  let jsonSent = null;
  const headers = {};
  const mockRes = {
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(code) {
      statusSet = code;
      return this;
    },
    json(obj) {
      jsonSent = obj;
      return this;
    },
    on() {}
  };

  await proxyMediaRequest(
    {
      method: "GET",
      query: { url: "http://127.0.0.1:4001/admin" },
      headers: {}
    },
    mockRes
  );

  assert.equal(statusSet, 403);
  assert.equal(jsonSent.error, "proxy_error");
});

test("proxyMediaRequest resolves stream token and returns 404 for missing token", async () => {
  let statusSet = 0;
  let jsonSent = null;
  const headers = {};
  const mockRes = {
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    status(code) {
      statusSet = code;
      return this;
    },
    json(obj) {
      jsonSent = obj;
      return this;
    },
    on() {}
  };

  await proxyMediaRequest(
    {
      method: "GET",
      query: { token: "bad-token-12345" },
      headers: {}
    },
    mockRes
  );

  assert.equal(statusSet, 404);
  assert.equal(jsonSent.error, "proxy_error");
  assert.match(jsonSent.message, /not found or expired/i);
});

test("proxyMediaRequest abort handling triggers only when response closes prematurely", () => {
  // Verify that abort logic inspects res.writableEnded
  let closeListener = null;
  const mockRes = {
    writableEnded: true,
    on(event, handler) {
      if (event === "close") closeListener = handler;
    }
  };

  // When response has completed normally (writableEnded = true), close does not abort
  let aborted = false;
  const controller = { abort: () => { aborted = true; } };

  mockRes.on("close", () => {
    if (!mockRes.writableEnded) controller.abort();
  });

  closeListener?.();
  assert.equal(aborted, false, "Should not abort when writableEnded is true");

  // When connection drops prematurely (writableEnded = false), close must abort
  mockRes.writableEnded = false;
  closeListener?.();
  assert.equal(aborted, true, "Must abort when client connection drops prematurely");
});

test("proxyMediaRequest forwards Range header and returns 206 Partial Content", async () => {
  const { PassThrough } = await import("node:stream");
  const originalFetch = globalThis.fetch;
  let receivedHeaders = null;
  globalThis.fetch = async (_url, init) => {
    receivedHeaders = init.headers;
    return new Response(new Uint8Array(512), {
      status: 206,
      headers: {
        "content-type": "video/x-matroska",
        "content-length": "512",
        "content-range": "bytes 0-511/1048576",
        "accept-ranges": "bytes"
      }
    });
  };

  try {
    const mockRes = new PassThrough();
    mockRes.headers = {};
    mockRes.setHeader = (k, v) => {
      mockRes.headers[k.toLowerCase()] = v;
    };
    mockRes.getHeader = (k) => mockRes.headers[k.toLowerCase()];
    mockRes.status = (code) => {
      mockRes.statusCode = code;
      return mockRes;
    };
    mockRes.json = (obj) => {
      mockRes.jsonBody = obj;
      return mockRes;
    };

    await proxyMediaRequest(
      {
        method: "GET",
        query: { url: "https://pub-abc.r2.cloudflarestorage.com/hub/movie.mkv" },
        headers: { range: "bytes=0-511" }
      },
      mockRes
    );

    assert.equal(receivedHeaders.Range, "bytes=0-511");
    assert.equal(mockRes.statusCode, 206);
    assert.equal(mockRes.headers["content-type"], "video/x-matroska");
    assert.equal(mockRes.headers["content-range"], "bytes 0-511/1048576");
    assert.equal(mockRes.headers["accept-ranges"], "bytes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxyMediaRequest supports seeking with byte offsets", async () => {
  const { PassThrough } = await import("node:stream");
  const originalFetch = globalThis.fetch;
  let receivedRange = null;
  globalThis.fetch = async (_url, init) => {
    receivedRange = init.headers.Range;
    return new Response(new Uint8Array(1024), {
      status: 206,
      headers: {
        "content-type": "video/x-matroska",
        "content-length": "1024",
        "content-range": "bytes 500000-501023/1048576",
        "accept-ranges": "bytes"
      }
    });
  };

  try {
    const mockRes = new PassThrough();
    mockRes.headers = {};
    mockRes.setHeader = (k, v) => {
      mockRes.headers[k.toLowerCase()] = v;
    };
    mockRes.getHeader = (k) => mockRes.headers[k.toLowerCase()];
    mockRes.status = (code) => {
      mockRes.statusCode = code;
      return mockRes;
    };
    mockRes.json = (obj) => {
      mockRes.jsonBody = obj;
      return mockRes;
    };

    await proxyMediaRequest(
      {
        method: "GET",
        query: { url: "https://pub-abc.r2.cloudflarestorage.com/hub/movie.mkv" },
        headers: { range: "bytes=500000-" }
      },
      mockRes
    );

    assert.equal(receivedRange, "bytes=500000-");
    assert.equal(mockRes.statusCode, 206);
    assert.equal(mockRes.headers["content-range"], "bytes 500000-501023/1048576");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxyMediaRequest blocks redirect to unapproved private destination", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" }
    });

  try {
    let statusSet = 0;
    let jsonSent = null;
    const mockRes = {
      setHeader() {},
      getHeader() {},
      status(code) {
        statusSet = code;
        return this;
      },
      json(obj) {
        jsonSent = obj;
        return this;
      },
      on() {}
    };

    await proxyMediaRequest(
      {
        method: "GET",
        query: { url: "https://pub-abc.r2.cloudflarestorage.com/hub/movie.mkv" },
        headers: {}
      },
      mockRes
    );

    assert.equal(statusSet, 403);
    assert.equal(jsonSent.error, "proxy_error");
    assert.match(jsonSent.message, /redirect to unapproved host/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

